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
  const semTitulo = String(raw || "")
    .replace(/^DEPUTAD[OA]\s+/i, "")
    .replace(/^DEP\.?\s+/i, "")
    .replace(/^SR\.?\s+/i, "")
    .replace(/^SRA\.?\s+/i, "")
    .replace(/\s*\(.*?\)\s*/g, " ");

  const semRuido = semTitulo
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\bPauta\b[\s\S]*$/i, " ")
    .replace(/[^A-Za-zÀ-ÿ\s-]/g, " ");

  return semRuido.replace(/\s+/g, " ").trim();
}

function classifyAutor(rawAutor) {
  const bruto = String(rawAutor || "").trim();
  if (!bruto) return { tipo: "desconhecido", nome: "" };

  const n = normalizeName(bruto);
  if (/\bSENADO\b/.test(n)) return { tipo: "senado", nome: "" };

  const temIndicadorDeputado = /\b(DEPUTAD|SR|SRA)\b/i.test(bruto);
  const muitosAutores = /\b(E OUTR|E OUTRA|E OUTROS|COMISSAO|MESA)\b/i.test(bruto);
  if (!temIndicadorDeputado || muitosAutores) {
    return { tipo: "nao_deputado_unico", nome: "" };
  }

  return { tipo: "deputado_unico", nome: cleanPersonName(bruto) };
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
    const autorClass = classifyAutor(autorRaw);
    relatorRaw = cleanPersonName(relatorRaw);
    blocks.push({
      item,
      projeto,
      autorBruto: autorRaw,
      autorTipo: autorClass.tipo,
      autorNome: autorClass.nome,
      relatorNome: relatorRaw,
    });
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
      if (!name) return { nomeOriginal: "", partido: "-", uf: "-", id: null };
      const key = normalizeName(name);
      if (!cache.has(key)) cache.set(key, await fetchDeputadoByName(name));
      return cache.get(key) || { nomeOriginal: name, partido: "-", uf: "-", id: null };
    }

    const itens = [];
    for (const item of parsedItems) {
      let autor = { nomeOriginal: item.autorNome || item.autorBruto || "", partido: "-", uf: "-", id: null };
      if (item.autorTipo === "deputado_unico" && item.autorNome) {
        autor = await enrich(item.autorNome);
      } else if (item.autorTipo === "senado") {
        autor = { nomeOriginal: "Autoria do Senado", partido: "-", uf: "-", id: null };
      }
      const relator = await enrich(item.relatorNome);
      itens.push({ item: item.item, projeto: item.projeto, autor, relator, autorTipo: item.autorTipo });
    }

    const autoresValidos = itens.filter((x) => x.autorTipo === "deputado_unico" && x.autor?.id);
    const autoresUnicos = new Set(autoresValidos.map((x) => normalizeName(x.autor?.nomeOriginal || "")).filter(Boolean)).size;
    const relatoresValidos = itens.filter((x) => x.relator?.id);
    const relatoresUnicos = new Set(relatoresValidos.map((x) => normalizeName(x.relator?.nomeOriginal || "")).filter(Boolean)).size;

    return json(200, {
      totalItens: itens.length,
      autoresUnicos,
      relatoresUnicos,
      autoresPorPartido: countByKey(autoresValidos.map((x) => x.autor?.partido)),
      relatoresPorPartido: countByKey(relatoresValidos.map((x) => x.relator?.partido)),
      itens,
    });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "Erro interno." });
  }
};
