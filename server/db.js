"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "data", "quotes.db");
const db = new Database(dbPath);

function getPeople() {
  return db.prepare("SELECT id, name AS displayName FROM people").all();
}

function getCandidateQuotes() {
  return db
    .prepare(
      `SELECT id, person_id AS personId, content, sent_at AS sentAt, source,
              humor_score AS humorScore, interest_score AS interestScore, times_played AS timesPlayed
       FROM quotes`
    )
    .all();
}

const bumpStmt = db.prepare("UPDATE quotes SET times_played = times_played + 1 WHERE id = ?");
function incrementTimesPlayed(quoteId) {
  bumpStmt.run(quoteId);
}

module.exports = { getPeople, getCandidateQuotes, incrementTimesPlayed };
