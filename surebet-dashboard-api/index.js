// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getSheetRows } from "./sheets.js";
import { initDb, dbAll, dbGet, dbRun } from "./db.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// inicializa banco
await initDb();

/** 🔹 Cache em memória das planilhas
 * key = sheet.id (tabela sheets)
 * value = { rows, updatedAt }
 */
const sheetRowsCache = new Map();

/** Lê linhas da planilha com cache */
async function getCachedSheetRows(sheet) {
  const cached = sheetRowsCache.get(sheet.id);
  if (cached) {
    return cached.rows;
  }

  const rows = await getSheetRows(sheet.google_sheet_id, sheet.range);

  sheetRowsCache.set(sheet.id, {
    rows,
    updatedAt: new Date().toISOString(),
  });

  return rows;
}

/** Converte string em BRL ("R$ 1.080,00") ou número para Number */
function parseNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") {
    return isNaN(v) ? 0 : v;
  }

  let s = String(v)
    .replace(/R\$/gi, "")
    .replace(/\s|\u00A0/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

/** "03/11/2025 22:29:54" -> "2025-11-03" */
function parseDateISO(v) {
  if (!v) return null;
  const s = String(v).trim();
  const datePart = s.split(" ")[0];

  const m = datePart.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const [, d, mth, y] = m;
    return `${y}-${mth}-${d}`;
  }
  return null;
}

/** GET /api/sheets - Lista as planilhas cadastradas */
app.get("/api/sheets", async (req, res) => {
  try {
    const rows = await dbAll("SELECT * FROM sheets ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar planilhas" });
  }
});

/** POST /api/sheets - Cadastra planilha */
app.post("/api/sheets", async (req, res) => {
  try {
    const { name, googleSheetId, range } = req.body;

    if (!name || !googleSheetId) {
      return res
        .status(400)
        .json({ error: "name e googleSheetId são obrigatórios" });
    }

    const result = await dbRun(
      "INSERT INTO sheets (name, google_sheet_id, range) VALUES (?, ?, ?)",
      [name, googleSheetId, range || "NOVEMBRO!A1:Z1000"]
    );

    const created = await dbGet("SELECT * FROM sheets WHERE id = ?", [
      result.lastID,
    ]);

    // nova planilha → invalida cache (mais simples limpar tudo)
    sheetRowsCache.clear();

    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao cadastrar planilha" });
  }
});

/** DELETE /api/sheets/:id - Remove planilha */
app.delete("/api/sheets/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sheet = await dbGet("SELECT * FROM sheets WHERE id = ?", [id]);
    if (!sheet) {
      return res.status(404).json({ error: "Planilha não encontrada" });
    }

    await dbRun("DELETE FROM sheets WHERE id = ?", [id]);

    // remove do cache também
    sheetRowsCache.delete(sheet.id);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao remover planilha" });
  }
});

/**
 * 🔹 Limpa cache das planilhas (botão "Atualizar dados" no front)
 * POST /api/dashboard/refresh-sheets
 */
app.post("/api/dashboard/refresh-sheets", async (req, res) => {
  try {
    sheetRowsCache.clear();
    res.json({
      ok: true,
      message:
        "Cache de planilhas limpo. Na próxima carga do dashboard ele vai ler tudo de novo do Google Sheets.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Erro ao limpar cache",
      detail: err.message,
    });
  }
});

/**
 * 🔹 Função auxiliar: monta stats a partir de `data` (linhas) e `grupos` (entradas)
 */
function buildStatsFromData(data, grupos) {
  const totalEntradas = grupos.length;

  const totalStake = data.reduce((sum, d) => sum + d.stake, 0);
  const totalLucro = data.reduce((sum, d) => sum + d.lucro, 0);
  const yieldPercent = totalStake > 0 ? (totalLucro / totalStake) * 100 : 0;

  const EPS = 1e-6;
  const greens = grupos.filter((g) => g.lucroTotal > EPS).length;
  const reds = grupos.filter((g) => g.lucroTotal < -EPS).length;
  const totalResolvidas = greens + reds;

  const greenPercent =
    totalResolvidas > 0 ? (greens / totalResolvidas) * 100 : 0;
  const redPercent =
    totalResolvidas > 0 ? (reds / totalResolvidas) * 100 : 0;

  // lucro por dia (linhas)
  const lucroPorDiaMap = {};
  for (const d of data) {
    if (!d.dataAposta) continue;
    if (!lucroPorDiaMap[d.dataAposta]) {
      lucroPorDiaMap[d.dataAposta] = 0;
    }
    lucroPorDiaMap[d.dataAposta] += d.lucro;
  }
  const lucroPorDia = Object.entries(lucroPorDiaMap)
    .map(([date, lucro]) => ({ date, lucro }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // por operador (usa grupos)
  const operadorMap = {};
  for (const g of grupos) {
    if (!operadorMap[g.operador]) {
      operadorMap[g.operador] = {
        operador: g.operador,
        entradas: 0,
        lucro: 0,
        stake_total: 0,
      };
    }
    const o = operadorMap[g.operador];
    o.entradas += 1;
    o.lucro += g.lucroTotal;
    o.stake_total += g.stakeTotal;
  }
  const porOperador = Object.values(operadorMap).map((o) => ({
    ...o,
    yield_percent: o.stake_total > 0 ? (o.lucro / o.stake_total) * 100 : 0,
  }));

  // por casa (linhas)
  const casaMap = {};
  for (const d of data) {
    if (!d.casa) continue;
    if (!casaMap[d.casa]) {
      casaMap[d.casa] = {
        casa: d.casa,
        entradas: 0,
        lucro: 0,
        stake_total: 0,
      };
    }
    const c = casaMap[d.casa];
    c.entradas += 1;
    c.lucro += d.lucro;
    c.stake_total += d.stake;
  }
  const porCasa = Object.values(casaMap).map((c) => ({
    ...c,
    yield_percent: c.stake_total > 0 ? (c.lucro / c.stake_total) * 100 : 0,
  }));

  // por esporte (linhas)
  const esporteMap = {};
  for (const d of data) {
    if (!d.esporte) continue;
    if (!esporteMap[d.esporte]) {
      esporteMap[d.esporte] = {
        esporte: d.esporte,
        entradas: 0,
        lucro: 0,
        stake_total: 0,
      };
    }
    const e = esporteMap[d.esporte];
    e.entradas += 1;
    e.lucro += d.lucro;
    e.stake_total += d.stake;
  }
  const porEsporte = Object.values(esporteMap).map((e) => ({
    ...e,
    yield_percent: e.stake_total > 0 ? (e.lucro / e.stake_total) * 100 : 0,
  }));

  return {
    overview: {
      totalLucro,
      totalStake,
      totalApostas: totalEntradas,
      yieldPercent,
      greenPercent,
      redPercent,
    },
    lucroPorDia,
    porOperador,
    porCasa,
    porEsporte,
  };
}

/**
 * 🔹 Dashboard de UMA planilha
 * GET /api/dashboard/overview?sheetDbId=1&operador=&from=&to=
 */
app.get("/api/dashboard/overview", async (req, res) => {
  try {
    const { sheetDbId, operador, from, to } = req.query;

    if (!sheetDbId) {
      return res.status(400).json({ error: "sheetDbId é obrigatório" });
    }

    const sheet = await dbGet("SELECT * FROM sheets WHERE id = ?", [sheetDbId]);
    if (!sheet) {
      return res.status(404).json({ error: "Planilha não encontrada" });
    }

    const rows = await getCachedSheetRows(sheet);

    const data = [];
    for (const r of rows) {
      const dataApostaISO = parseDateISO(r["DATA APOSTA"]);

      // 👉 se não tiver data válida, ignora essa linha
      if (!dataApostaISO) continue;

      const lucro = parseNumber(r["LUCRO"]);
      const stake = parseNumber(r["STAKE"]);
      const casa = r["CASA"] || "";
      const esporte = r["ESPORTE"] || "";
      const evento = (r["EVENTO"] || "").trim();
      const dataEvento = (r["DATA EVENTO"] || "").trim();

      const op = (sheet.name || "SEM OPERADOR").trim();

      if (operador && op !== operador) continue;
      if (from && dataApostaISO < from) continue;
      if (to && dataApostaISO > to) continue;

      data.push({
        dataAposta: dataApostaISO,
        operador: op,
        casa,
        esporte,
        evento,
        dataEvento,
        stake,
        lucro,
      });
    }

    // agrupa por entrada (surebet) dentro da planilha
    const gruposMap = new Map();
    for (const d of data) {
      const key = `${d.dataAposta || ""}|${(d.evento || "")
        .toLowerCase()
        .trim()}|${d.operador}`;

      if (!gruposMap.has(key)) {
        gruposMap.set(key, {
          dataAposta: d.dataAposta,
          operador: d.operador,
          evento: d.evento,
          esporte: d.esporte,
          lucroTotal: 0,
          stakeTotal: 0,
        });
      }
      const g = gruposMap.get(key);
      g.lucroTotal += d.lucro;
      g.stakeTotal += d.stake;
    }

    const grupos = Array.from(gruposMap.values());
    const result = buildStatsFromData(data, grupos);

    res.json(result);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Erro ao montar overview", detail: err.message });
  }
});

/**
 * 🔹 Dashboard GERAL (TODAS as planilhas)
 * GET /api/dashboard/overview-all?from=&to=&operador=
 */
app.get("/api/dashboard/overview-all", async (req, res) => {
  try {
    const { from, to, operador } = req.query;

    const sheets = await dbAll("SELECT * FROM sheets");
    if (!sheets || sheets.length === 0) {
      return res.status(400).json({ error: "Nenhuma planilha cadastrada" });
    }

    const data = [];
    const gruposMap = new Map();

    for (const sheet of sheets) {
      const opName = (sheet.name || "SEM OPERADOR").trim();
      if (operador && opName !== operador) {
        // se quiser filtrar por um operador específico no geral
        continue;
      }

      const rows = await getCachedSheetRows(sheet);

      for (const r of rows) {
        const dataApostaISO = parseDateISO(r["DATA APOSTA"]);

        // 👉 idem: sem data válida, ignora
        if (!dataApostaISO) continue;

        const lucro = parseNumber(r["LUCRO"]);
        const stake = parseNumber(r["STAKE"]);
        const casa = r["CASA"] || "";
        const esporte = r["ESPORTE"] || "";
        const evento = (r["EVENTO"] || "").trim();
        const dataEvento = (r["DATA EVENTO"] || "").trim();

        if (from && dataApostaISO < from) continue;
        if (to && dataApostaISO > to) continue;

        const d = {
          dataAposta: dataApostaISO,
          operador: opName,
          casa,
          esporte,
          evento,
          dataEvento,
          stake,
          lucro,
        };
        data.push(d);

        // agrupa por entrada (surebet) em TODAS as planilhas
        const key = `${d.dataAposta || ""}|${(d.evento || "")
          .toLowerCase()
          .trim()}|${d.operador}`;

        if (!gruposMap.has(key)) {
          gruposMap.set(key, {
            dataAposta: d.dataAposta,
            operador: d.operador,
            evento: d.evento,
            esporte: d.esporte,
            lucroTotal: 0,
            stakeTotal: 0,
          });
        }
        const g = gruposMap.get(key);
        g.lucroTotal += d.lucro;
        g.stakeTotal += d.stake;
      }
    }

    const grupos = Array.from(gruposMap.values());
    const result = buildStatsFromData(data, grupos);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Erro ao montar overview geral",
      detail: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
});
