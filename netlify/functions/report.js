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
    .replace(/^DEP(?:UTAD[OA])?\.?\s+/i, "")
    .replace(/^DEPª\.?\s+/i, "")
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

  const temIndicadorDeputado = /\b(DEPUTAD|DEP\.|DEP |SR|SRA)\b/i.test(bruto);
  if (!temIndicadorDeputado || /\b(COMISSAO|MESA)\b/i.test(bruto)) {
    return { tipo: "nao_deputado_unico", nome: "" };
  }

  const somentePrimeiroAutor = bruto.replace(/\s+e\s+outr[oa]s?.*$/i, "");
  return { tipo: "deputado_unico", nome: cleanPersonName(somentePrimeiroAutor) };
}

function splitAutores(rawAutor) {
  const bruto = String(rawAutor || "").trim();
  if (!bruto) return [];
  const normalized = normalizeName(bruto);
  if (/\bSENADO\b/.test(normalized)) return [];
  if (/\b(COMISSAO|MESA)\b/.test(normalized)) return [];

  let semRotulo = bruto
    .replace(/\bdos\s+Srs?\.?\b/gi, "")
    .replace(/\bdas\s+Sras?\.?\b/gi, "")
    .replace(/\bdo\s+Sr\.?\b/gi, "")
    .replace(/\bda\s+Sra\.?\b/gi, "")
    .replace(/\bdo\s+Deputado\b/gi, "")
    .replace(/\bda\s+Deputada\b/gi, "")
    .replace(/\bdeputad[oa]s?\b/gi, "")
    .replace(/\bdep(?:utad[oa])?\.?\b/gi, "")
    .replace(/\s+e\s+outros?.*$/i, "")
    .trim();

  semRotulo = semRotulo.replace(/\s*\/\s*[A-Z]{2}\b/g, " ");
  const partes = semRotulo
    .split(/\s+e\s+|,\s*/i)
    .map((p) => cleanPersonName(p))
    .filter((p) => p.length >= 3);
  return [...new Set(partes)];
}

function parseAgendaItems(text) {
  const blocks = [];
  const regex = /(^|\n)\s*(\d+)\s*-\s*([\s\S]*?)(?=\n\s*\d+\s*-\s*|\n\s*[A-Z]\s*-\s*Proposi|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const item = match[2];
    const body = match[3].replace(/\s+/g, " ").trim();
    if (!/^(PROJETO|REQUERIMENTO)\b/i.test(body)) continue;
    const projeto =
      body.match(/((?:PROJETO|REQUERIMENTO)[\s\S]*?)(?=\s+RELATOR(?:A)?:|\s+PARECER:|$)/i)?.[1]?.trim() || body;
    let autorRaw =
      body.match(/-\s+d[oa]s?\s+(.+?)\s+-\s+que/i)?.[1] ||
      body.match(/-\s+d[oa]s?\s+(.+?)\s+RELATOR(?:A)?:/i)?.[1] ||
      "";
    let relatorRaw = body.match(/RELATOR(?:A)?:\s*(.+?)(?=\s+PARECER:|$)/i)?.[1] || "";
    const autorClass = classifyAutor(autorRaw);
    const autoresNomes = splitAutores(autorRaw);
    relatorRaw = cleanPersonName(relatorRaw);
    blocks.push({
      item,
      projeto,
      autorBruto: autorRaw,
      autorTipo: autorClass.tipo,
      autorNome: autorClass.nome,
      autoresNomes,
      relatorNome: relatorRaw,
      tipoItem: /^REQUERIMENTO\b/i.test(body) ? "requerimento" : "projeto",
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

async function fetchDeputadosByLegislatura(idLegislatura) {
  const all = [];
  for (let pagina = 1; pagina <= 12; pagina++) {
    const response = await fetch(
      `https://dadosabertos.camara.leg.br/api/v2/deputados?idLegislatura=${idLegislatura}&itens=100&pagina=${pagina}&ordem=ASC&ordenarPor=nome`,
      { headers: { accept: "application/json" } }
    );
    if (!response.ok) break;
    const json = await response.json();
    const rows = Array.isArray(json?.dados) ? json.dados : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function fetchAllDeputados() {
  const candidatos = [
    ...(await fetchDeputadosByLegislatura(57)),
    ...(await fetchDeputadosByLegislatura(56)),
  ];
  const porId = new Map();
  for (const dep of candidatos) {
    if (!dep?.id) continue;
    if (!porId.has(dep.id)) porId.set(dep.id, dep);
  }
  return [...porId.values()];
}

function findDeputadoByName(name, deputados) {
  if (!name) return null;
  const wanted = normalizeName(name);
  if (!wanted) return null;

  let best = null;
  let bestScore = -1;
  for (const dep of deputados) {
    const candidate = normalizeName(dep.nome || "");
    if (!candidate) continue;
    let score = 0;
    if (candidate === wanted) score = 100;
    else if (candidate.startsWith(wanted) || wanted.startsWith(candidate)) score = 80;
    else if (candidate.includes(wanted) || wanted.includes(candidate)) score = 60;
    else {
      const tokens = wanted.split(" ").filter((x) => x.length > 2);
      const hit = tokens.filter((t) => candidate.includes(t)).length;
      score = hit * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = dep;
    }
  }

  if (!best || bestScore < 10) return null;
  return {
    nomeOriginal: name,
    nomeApi: best.nome || name,
    partido: best.siglaPartido || "-",
    uf: best.siglaUf || "-",
    id: best.id || null,
  };
}

async function fetchDeputadoByQuery(name) {
  const encoded = encodeURIComponent(name);
  const response = await fetch(`https://dadosabertos.camara.leg.br/api/v2/deputados?nome=${encoded}&itens=10`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return null;
  const json = await response.json();
  const rows = Array.isArray(json?.dados) ? json.dados : [];
  if (!rows.length) return null;
  const dep = rows[0];
  return {
    nomeOriginal: name,
    nomeApi: dep.nome || name,
    partido: dep.siglaPartido || "-",
    uf: dep.siglaUf || "-",
    id: dep.id || null,
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

    const deputados = await fetchAllDeputados();
    const cache = new Map();
    async function enrich(name) {
      if (!name) return { nomeOriginal: "", partido: "-", uf: "-", id: null };
      const key = normalizeName(name);
      if (!cache.has(key)) {
        let found = findDeputadoByName(name, deputados);
        if (!found) found = await fetchDeputadoByQuery(name);
        cache.set(key, found);
      }
      return cache.get(key) || { nomeOriginal: name, partido: "-", uf: "-", id: null };
    }

    const itens = [];
    const autoresPartidosPorItem = new Map();
    const relatoresPorItem = new Map();
    for (const item of parsedItems) {
      const relator = item.tipoItem === "requerimento" ? { nomeOriginal: "-", partido: "-", uf: "-", id: null } : await enrich(item.relatorNome);
      const itemKey = `${item.item}|${item.projeto}`;
      if (relator?.id && relator.partido && relator.partido !== "-") {
        relatoresPorItem.set(itemKey, relator);
      }

      if (item.autorTipo === "senado") {
        itens.push({
          item: item.item,
          projeto: item.projeto,
          autor: { nomeOriginal: "Autoria do Senado", partido: "-", uf: "-", id: null },
          relator,
          autorTipo: item.autorTipo,
          tipoItem: item.tipoItem,
        });
        continue;
      }

      const autoresCandidatos = item.autoresNomes.length ? item.autoresNomes : item.autorNome ? [item.autorNome] : [];
      if (!autoresCandidatos.length) {
        itens.push({
          item: item.item,
          projeto: item.projeto,
          autor: { nomeOriginal: item.autorBruto || "-", partido: "-", uf: "-", id: null },
          relator,
          autorTipo: "nao_deputado_unico",
          tipoItem: item.tipoItem,
        });
        continue;
      }

      for (const nomeAutor of autoresCandidatos) {
        const autor = await enrich(nomeAutor);
        const row = {
          item: item.item,
          projeto: item.projeto,
          autor,
          relator,
          autorTipo: autor?.id ? "deputado_unico" : "nao_deputado_unico",
          tipoItem: item.tipoItem,
        };
        itens.push(row);
        if (autor?.id && autor.partido && autor.partido !== "-") {
          if (!autoresPartidosPorItem.has(itemKey)) autoresPartidosPorItem.set(itemKey, new Set());
          autoresPartidosPorItem.get(itemKey).add(autor.partido);
        }
      }
    }

    const autoresValidos = itens.filter((x) => x.autorTipo === "deputado_unico" && x.autor?.id);
    const autoresUnicos = new Set(autoresValidos.map((x) => normalizeName(x.autor?.nomeOriginal || "")).filter(Boolean)).size;
    const relatoresValidos = [...relatoresPorItem.values()];
    const relatoresUnicos = new Set(relatoresValidos.map((x) => normalizeName(x.nomeOriginal || "")).filter(Boolean)).size;
    const partidosAutoresContabilizados = [];
    for (const setPartidos of autoresPartidosPorItem.values()) {
      for (const p of setPartidos.values()) partidosAutoresContabilizados.push(p);
    }

    return json(200, {
      totalItens: parsedItems.length,
      totalLinhasDetalhe: itens.length,
      autoresUnicos,
      relatoresUnicos,
      autoresPorPartido: countByKey(partidosAutoresContabilizados),
      relatoresPorPartido: countByKey(relatoresValidos.map((x) => x.partido)),
      itens,
    });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "Erro interno." });
  }
};
