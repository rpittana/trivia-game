"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "data", "quotes.db");
const db = new Database(dbPath);

// Guard against starting against a DB that predates the `upvotes` column
// (ingest's buildDatabase also creates it, but the server shouldn't depend on
// having been re-ingested since the last schema change).
const feedbackTableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quote_feedback'")
  .all().length > 0;
if (feedbackTableExists) {
  const feedbackCols = db.prepare("PRAGMA table_info(quote_feedback)").all().map((c) => c.name);
  if (!feedbackCols.includes("upvotes")) {
    db.exec("ALTER TABLE quote_feedback ADD COLUMN upvotes INTEGER NOT NULL DEFAULT 0");
  }
}

function getPeople() {
  return db.prepare("SELECT id, name AS displayName, color FROM people").all();
}

function getCandidateQuotes() {
  return db
    .prepare(
      `SELECT q.id, q.person_id AS personId, q.content, q.sent_at AS sentAt, q.source,
              q.humor_score AS humorScore, q.interest_score AS interestScore, q.times_played AS timesPlayed,
              COALESCE(f.downvotes, 0) AS downvotes, COALESCE(f.upvotes, 0) AS upvotes
       FROM quotes q
       LEFT JOIN quote_feedback f ON f.message_id = q.id`
    )
    .all();
}

const bumpStmt = db.prepare("UPDATE quotes SET times_played = times_played + 1 WHERE id = ?");
function incrementTimesPlayed(quoteId) {
  bumpStmt.run(quoteId);
}

const downvoteStmt = db.prepare(
  `INSERT INTO quote_feedback (message_id, downvotes) VALUES (?, 1)
   ON CONFLICT(message_id) DO UPDATE SET downvotes = downvotes + 1`
);
const getDownvotesStmt = db.prepare("SELECT downvotes FROM quote_feedback WHERE message_id = ?");
function downvoteQuote(messageId) {
  downvoteStmt.run(messageId);
  return getDownvotesStmt.get(messageId).downvotes;
}

const upvoteStmt = db.prepare(
  `INSERT INTO quote_feedback (message_id, upvotes) VALUES (?, 1)
   ON CONFLICT(message_id) DO UPDATE SET upvotes = upvotes + 1`
);
const getUpvotesStmt = db.prepare("SELECT upvotes FROM quote_feedback WHERE message_id = ?");
function upvoteQuote(messageId) {
  upvoteStmt.run(messageId);
  return getUpvotesStmt.get(messageId).upvotes;
}

const recordRevealStmt = db.prepare(
  `INSERT INTO person_stats (person_id, quotes_shown, total_guesses, correct_guesses) VALUES (?, 1, ?, ?)
   ON CONFLICT(person_id) DO UPDATE SET
     quotes_shown = quotes_shown + 1,
     total_guesses = total_guesses + excluded.total_guesses,
     correct_guesses = correct_guesses + excluded.correct_guesses`
);
function recordReveal(personId, totalGuesses, correctGuesses) {
  recordRevealStmt.run(personId, totalGuesses, correctGuesses);
}

const MIN_GUESSABILITY_SAMPLE = 10;
function getGuessability() {
  return db
    .prepare(
      `SELECT p.id AS personId, p.name AS name, s.total_guesses AS sample,
              ROUND(100.0 * s.correct_guesses / s.total_guesses, 1) AS pct
       FROM person_stats s
       JOIN people p ON p.id = s.person_id
       WHERE s.total_guesses >= ?
       ORDER BY pct DESC`
    )
    .all(MIN_GUESSABILITY_SAMPLE);
}

module.exports = {
  getPeople,
  getCandidateQuotes,
  incrementTimesPlayed,
  downvoteQuote,
  upvoteQuote,
  recordReveal,
  getGuessability,
};
