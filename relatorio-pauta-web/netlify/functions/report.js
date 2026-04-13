const multipart = require("lambda-multipart-parser");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");

function normalizeName(name) {
  return String(name || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPersonName(raw) {
  return String(raw || "")
    .replace(/^DEPUTAD[OA]\s+/i, "")
    .replace(/^DEP\.?\s+/i, "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAgendaItems(text) {
  const blocks = [];
  const regex = /(^|\n)\s*(\d+)\s*-\s*(PROJETO[\s\S]*?)(?=\n\s*\d+\s*-\s*PROJETO|\n\s*[A-Z]\s*-\s*Proposi|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const item = match[2];
    const body = match[3].replace(/\s+/g, " ").trim();
    const projeto = body.match(/(PROJETO\s+DE\s+[A-Z]+[\s\S]*?)(?=\s+RELATOR:|\s+PARECER:|$)/i)?.[1]?.trim() || body;
    let autorRaw = body.match(/-\s+do\s+(.+?)\s+-\s+que/i)?.[1] || body.match(/-\s+do\s+(.+?)\s+RELATOR:/i)?.[1] || "";
    let relatorRaw = body.match(/RELATOR:\s*(.+?)(?=\s+PARECER:|$)/i)?.[1] || "";
    autorRaw = cleanPersonName(autorRaw);
    relatorRaw = cleanPersonName(relatorRaw);
    blocks.push({ item, projeto, autorNome: autorRaw, relatorNome: relatorRaw });
  }
  return blocks;
}

async function extractTextFromUpload(file) {
  const filename = String(file.filename || "").toLowerCase();
  const buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "");
  if (filename.endsWith(".pdf")) {
    const data = await pdf(buffer);
    return data.text || "";
  }
  if (filename.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  return buffer.toString("utf-8");
}

async function fetchDeputadoByName(name) {
  if (!name) return null;
  const encoded = encodeURIComponent(name);
  const response = await fetch(`https://dadosabertos.camara.leg.br/api/v2/deputados?nome=${encoded}&itens=20`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const json = await response.json();
  const rows = Array.isArray(json?.dados) ? json.dados : [];
  if (!rows.length) return null;
  const wanted = normalizeName(name);
  let selected = rows[0];
  for (const row of rows) {
    const candidate = normalizeName(row.nome || "");
    if (candidate === wanted) {
      selected = row;
      break;
    }
    if (candidate.includes(wanted) || wanted.includes(candidate)) selected = row;
  }
  return {
    nomeOriginal: name,
    nomeApi: selected.nome || name,
    partido: selected.siglaPartido || "N/I",
    uf: selected.siglaUf || "N/I",
    id: selected.id || null,
  };
}

function countByKey(values) {
  const map = new Map();
  for (const value of values) {
    const key = value || "N/I";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Metodo nao permitido." });
    const parsed = await multipart.parse(event);
    const file = (parsed.files || []).find((f) => f.fieldname === "pauta") || parsed.files?.[0];
    if (!file) return json(400, { error: "Arquivo nao enviado." });

    const text = await extractTextFromUpload(file);
    if (!text.trim()) return json(422, { error: "Nao foi possivel extrair texto do arquivo." });

    const parsedItems = parseAgendaItems(text);
    if (!parsedItems.length) return json(422, { error: "Nenhum item de projeto identificado na pauta enviada." });

    const cache = new Map();
    async function enrich(name) {
      if (!name) return { nomeOriginal: "", partido: "N/I", uf: "N/I", id: null };
      const key = normalizeName(name);
      if (!cache.has(key)) cache.set(key, await fetchDeputadoByName(name));
      return cache.get(key) || { nomeOriginal: name, partido: "N/I", uf: "N/I", id: null };
    }

    const itens = [];
    for (const item of parsedItems) {
      const autor = await enrich(item.autorNome);
      const relator = await enrich(item.relatorNome);
      itens.push({ item: item.item, projeto: item.projeto, autor, relator });
    }

    const autoresUnicos = new Set(itens.map((x) => normalizeName(x.autor?.nomeOriginal || "")).filter(Boolean)).size;
    const relatoresUnicos = new Set(itens.map((x) => normalizeName(x.relator?.nomeOriginal || "")).filter(Boolean)).size;

    return json(200, {
      totalItens: itens.length,
      autoresUnicos,
      relatoresUnicos,
      autoresPorPartido: countByKey(itens.map((x) => x.autor?.partido)),
      relatoresPorPartido: countByKey(itens.map((x) => x.relator?.partido)),
      itens,
    });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "Erro interno." });
  }
};
