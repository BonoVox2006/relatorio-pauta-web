const uploadForm = document.getElementById("uploadForm");
const fileInput = document.getElementById("fileInput");
const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");
const summaryCard = document.getElementById("summaryCard");
const tablesGrid = document.getElementById("tablesGrid");
const itemsCard = document.getElementById("itemsCard");

const metricItens = document.getElementById("metricItens");
const metricAutores = document.getElementById("metricAutores");
const metricRelatores = document.getElementById("metricRelatores");

const autorPartidoBody = document.getElementById("autorPartidoBody");
const relatorPartidoBody = document.getElementById("relatorPartidoBody");
const itemsBody = document.getElementById("itemsBody");

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setStatus(text) {
  show(statusCard);
  statusText.textContent = text;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nomeDeputado(p) {
  if (!p) return "-";
  const n = p.nomeApi || p.nomeOriginal;
  return n ? esc(n) : "-";
}

function fillCountTable(tbody, rows) {
  tbody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='2'>Sem dados</td>";
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.key}</td><td>${row.count}</td>`;
    tbody.appendChild(tr);
  }
}

function renderItems(items) {
  itemsBody.innerHTML = "";
  if (!items.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='6'>Nenhum item identificado na pauta.</td>";
    itemsBody.appendChild(tr);
    return;
  }
  for (const item of items) {
    const autorPartidoUf =
      item.autorTipo === "senado"
        ? "Desconsiderado (Senado)"
        : `${item.autor?.partido || "-"} / ${item.autor?.uf || "-"}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(item.item || "-")}</td>
      <td>${esc(item.projeto || "-")}</td>
      <td>${nomeDeputado(item.autor)}</td>
      <td>${esc(autorPartidoUf)}</td>
      <td>${nomeDeputado(item.relator)}</td>
      <td>${esc(`${item.relator?.partido || "-"} / ${item.relator?.uf || "-"}`)}</td>
    `;
    itemsBody.appendChild(tr);
  }
}

function renderReport(data) {
  metricItens.textContent = String(data.totalItens || 0);
  metricAutores.textContent = String(data.autoresUnicos || 0);
  metricRelatores.textContent = String(data.relatoresUnicos || 0);
  fillCountTable(autorPartidoBody, data.autoresPorPartido || []);
  fillCountTable(relatorPartidoBody, data.relatoresPorPartido || []);
  renderItems(data.itens || []);
  show(summaryCard);
  show(tablesGrid);
  show(itemsCard);
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!fileInput.files || !fileInput.files[0]) {
    setStatus("Selecione um arquivo.");
    return;
  }

  hide(summaryCard);
  hide(tablesGrid);
  hide(itemsCard);
  setStatus("Processando pauta e consultando Dados Abertos...");

  const formData = new FormData();
  formData.append("pauta", fileInput.files[0]);

  try {
    const response = await fetch("/.netlify/functions/report-v2", { method: "POST", body: formData });
    const raw = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`Servidor retornou resposta inválida (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(payload.error || "Falha ao gerar relatório.");
    renderReport(payload);
    setStatus("Relatório gerado com sucesso.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Erro inesperado.");
  }
});
