// sheets.js
import { google } from "googleapis";

/**
 * Carrega credenciais do Service Account via variável de ambiente
 * (NUNCA mais usar arquivo .json)
 */
const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!rawCredentials) {
  console.error("❌ ERRO FATAL: Variável GOOGLE_SERVICE_ACCOUNT_KEY não configurada.");
  throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY ausente");
}

let credentials;
try {
  credentials = JSON.parse(rawCredentials);
} catch (e) {
  console.error("❌ ERRO: Não foi possível dar parse na GOOGLE_SERVICE_ACCOUNT_KEY.");
  throw e;
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

/** Normaliza texto */
function norm(cell) {
  return String(cell || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mapeia cabeçalhos */
function canonicalHeaderName(raw) {
  const n = norm(raw);

  if (n.includes("DATA APOSTA")) return "DATA APOSTA";
  if (n === "LUCRO") return "LUCRO";
  if (n === "STAKE") return "STAKE";
  if (n === "CASA" || n.includes("BOOK")) return "CASA";
  if (n === "ESPORTE" || n === "ESPORTES") return "ESPORTE";
  if (n.includes("DATA EVENTO") || n.includes("DATA JOGO")) return "DATA EVENTO";
  if (n === "EVENTO" || n === "PARTIDA" || n.includes("MATCH")) return "EVENTO";

  return String(raw || "").trim();
}

/** Extrai header e linhas de dados */
function extractRowsFromValues(values, mainHeader = null) {
  if (!values?.length) return { header: mainHeader, rows: [] };

  const headerIndex = values.findIndex((row) =>
    row.some((cell) => norm(cell).includes("DATA APOSTA"))
  );

  if (headerIndex === -1) {
    console.warn("⚠️ Cabeçalho 'DATA APOSTA' não encontrado");
    return { header: mainHeader, rows: [] };
  }

  const headerRow = values[headerIndex];
  const headerRaw = mainHeader || headerRow;
  const header = headerRaw.map((c) => canonicalHeaderName(c));

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

/**
 * Lê linhas da planilha (todas as abas ou uma aba específica)
 */
export async function getSheetRows(sheetId, range = "A1:Z1000") {
  try {
    // Se especificou aba (ex: "NOVEMBRO!A1:Z1000")
    if (range.includes("!")) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });

      const values = res.data.values || [];
      if (!values.length) return [];

      return extractRowsFromValues(values).rows;
    }

    // Caso contrário, percorre todas as abas
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "sheets.properties.title",
    });

    const sheetProps = meta.data.sheets || [];
    let allRows = [];
    let mainHeader = null;

    for (const sh of sheetProps) {
      const title = sh.properties?.title;
      if (!title) continue;

      const fullRange = `${title}!${range}`;

      try {
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: fullRange,
        });

        const values = res.data.values || [];
        if (!values.length) continue;

        const { header, rows } = extractRowsFromValues(values, mainHeader);

        if (!mainHeader && header) {
          mainHeader = header; // trava header padrão
        }

        allRows = allRows.concat(rows);
      } catch (err) {
        console.warn(`⚠️ Erro ao ler aba ${title}:`, err.message);
      }
    }

    return allRows;
  } catch (err) {
    console.error("❌ Erro ao ler planilha:", err.message);

    if (err.code === 404 || err?.response?.status === 404) {
      console.error("⚠️ Planilha não encontrada. Verifique o ID.");
    }

    throw err;
  }
}
