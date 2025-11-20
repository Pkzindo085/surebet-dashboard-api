// sheets.js
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AJUSTA o nome se seu arquivo JSON tiver outro nome
const serviceAccountPath = path.join(
  __dirname,
  "surebet-dashboard-c11e36c25e23.json"
);

if (!fs.existsSync(serviceAccountPath)) {
  console.error("Arquivo de credenciais NÃO encontrado em:", serviceAccountPath);
  throw new Error("Service account JSON não encontrado");
}

const credentials = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

/**
 * normaliza texto de célula (pra achar "DATA APOSTA" mesmo se tiver acento, espaço, etc.)
 */
function norm(cell) {
  return String(cell || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mapeia diversos cabeçalhos para nomes canônicos
 * que o backend usa (DATA APOSTA, LUCRO, STAKE etc.)
 */
function canonicalHeaderName(raw) {
  const n = norm(raw);

  if (n.includes("DATA APOSTA")) return "DATA APOSTA";
  if (n === "LUCRO") return "LUCRO";
  if (n === "STAKE") return "STAKE";
  if (n === "CASA" || n.includes("BOOK")) return "CASA";
  if (n === "ESPORTE" || n === "ESPORTES") return "ESPORTE";
  if (n.includes("DATA EVENTO") || n.includes("DATA JOGO")) return "DATA EVENTO";
  if (n === "EVENTO" || n === "PARTIDA" || n.includes("MATCH")) return "EVENTO";

  // qualquer outro mantém o texto original, só trim
  return String(raw || "").trim();
}

/**
 * Extrai header + linhas de dados de um values[][],
 * usando a linha que contém "DATA APOSTA" como cabeçalho.
 */
function extractRowsFromValues(values, mainHeader = null) {
  if (!values || values.length === 0) {
    return { header: mainHeader, rows: [] };
  }

  // acha a linha onde aparece "DATA APOSTA" em QUALQUER coluna
  const headerIndex = values.findIndex((row) =>
    row.some((cell) => norm(cell).includes("DATA APOSTA"))
  );

  if (headerIndex === -1) {
    console.warn("Cabeçalho 'DATA APOSTA' não encontrado nesta aba");
    return { header: mainHeader, rows: [] };
  }

  const headerRow = values[headerIndex];

  // se já temos um header principal, usamos ele; senão usamos desta aba
  const headerRaw = mainHeader || headerRow;

  // AQUI padronizamos os nomes das colunas
  const header = headerRaw.map((c) => canonicalHeaderName(c));

  // linhas de dados = abaixo do cabeçalho e não totalmente vazias
  const dataRows = values
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell).trim() !== ""));

  const rows = dataRows.map((row) => {
    const obj = {};
    header.forEach((col, idx) => {
      if (!col) return;
      obj[col] = row[idx] ?? "";
    });
    return obj;
  });

  return { header, rows };
}

export async function getSheetRows(sheetId, range = "NOVEMBRO!A1:Z1000") {
  try {
    const spreadsheetId = sheetId;

    // 1) Se range tiver "!" → lê UMA aba só (comportamento direto)
    if (range.includes("!")) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const values = res.data.values || [];
      if (!values.length) return [];

      const { rows } = extractRowsFromValues(values);
      return rows;
    }

    // 2) Se NÃO tiver "!" → considera como intervalo padrão (ex: "A1:Z1000") e percorre TODAS as abas
    const defaultRange = range || "A1:Z1000";

    // pega lista de abas
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });

    const sheetProps = meta.data.sheets || [];
    let allRows = [];
    let mainHeader = null; // header canônico que será reaproveitado entre abas

    for (const sh of sheetProps) {
      const title = sh.properties?.title;
      if (!title) continue;

      const fullRange = `${title}!${defaultRange}`;

      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: fullRange,
        });

        const values = res.data.values || [];
        if (!values.length) continue;

        const { header, rows } = extractRowsFromValues(values, mainHeader);
        if (!mainHeader && header) {
          mainHeader = header; // guarda o primeiro header canônico encontrado
        }

        allRows = allRows.concat(rows);
      } catch (err) {
        console.error(`Erro ao ler aba ${title} (${fullRange}):`, err.message);
        // segue pra próxima aba
      }
    }

    return allRows;
  } catch (err) {
    if (err.code === 404 || err?.response?.status === 404) {
      console.error(
        "Planilha não encontrada. Confere se o ID está certo (ID do /d/, não o gid=...)."
      );
    } else {
      console.error("Erro ao ler planilha do Google:", err.message);
    }
    throw err;
  }
}
