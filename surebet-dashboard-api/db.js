// db.js
import sqlite3 from "sqlite3";

sqlite3.verbose();

const DB_PATH = "./data.db";
export const db = new sqlite3.Database(DB_PATH);

export function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

export function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

export function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

export async function initDb() {
  // tabela onde vamos guardar as planilhas
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      google_sheet_id TEXT NOT NULL,
      range TEXT DEFAULT 'NOVEMBRO!A1:Z1000',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
