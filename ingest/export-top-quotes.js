// One-off utility: writes the top N quotes by humor_score to a text file.
// Usage: node ingest/export-top-quotes.js [count] [outputFile]
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const count = parseInt(process.argv[2], 10) || 50;
const outputFile = process.argv[3] || path.join(__dirname, "..", "data", "top-quotes.txt");

const dbPath = path.join(__dirname, "..", "data", "quotes.db");
const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT q.content, q.humor_score as humorScore, q.source, p.name as name
     FROM quotes q
     JOIN people p ON p.id = q.person_id
     ORDER BY q.humor_score DESC
     LIMIT ?`
  )
  .all(count);
db.close();

const lines = rows.map((r, i) => `${i + 1}. [${r.humorScore.toFixed(0)}] (${r.source}) ${r.name}: ${r.content}`);
fs.writeFileSync(outputFile, lines.join("\n") + "\n");

console.log(`Wrote ${rows.length} quotes to ${outputFile}`);
