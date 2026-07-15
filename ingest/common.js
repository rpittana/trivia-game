// Shared pipeline: filtering, normalization, scoring, LLM curation, and DB writing.
// Used by both ingest/ingest.js (Discord adapter) and ingest/imessage.js (iMessage adapter).
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";

// Bump whenever a Stage A/B prompt string changes below, so stale cached ratings are re-run.
const PROMPT_VERSION = "v2";

const LAUGH_RE = /\b(lm(a|f)o+|lo+l+|haha+|bruh+|wtf)\b|😂|💀|🤣/i;
const URL_RE = /https?:\/\//i;
const COMMAND_PREFIX_RE = /^[!/.\-]\w/;
const MENTION_RE = /<@!?(\d+)>/g;
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeContent(content) {
  let text = content.replace(MENTION_RE, "@someone");
  text = text.replace(CUSTOM_EMOJI_RE, ":$1:");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function nonAlphaRatio(content) {
  const chars = content.replace(/\s/g, "");
  if (chars.length === 0) return 1;
  const alpha = chars.replace(/[^a-zA-Z]/g, "");
  return 1 - alpha.length / chars.length;
}

function percentileNormalize(values) {
  const sorted = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const result = new Array(values.length);
  const n = sorted.length;
  sorted.forEach(([, originalIdx], rank) => {
    result[originalIdx] = n <= 1 ? 100 : Math.round((rank / (n - 1)) * 100);
  });
  return result;
}

// ---------- people.json ----------

function peopleConfigPath() {
  return path.join(__dirname, "..", "data", "people.json");
}

function loadPeopleConfig() {
  const configPath = peopleConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `data/people.json not found. Run "node ingest/ingest.js --init-config <export.json ...>" first, ` +
        `then edit the file to control who's included before running ingest normally.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const people = raw.people || [];

  const byDiscordId = new Map();
  const byImessageHandle = new Map();
  const includedPeople = [];
  const nameRegexes = [];

  for (const person of people) {
    if (!person.include) continue;
    includedPeople.push({ id: person.id, name: person.name });
    for (const id of person.discordIds || []) byDiscordId.set(id, person.id);
    for (const handle of person.imessageHandles || []) byImessageHandle.set(handle, person.id);
    if (person.name && person.name.trim().length >= 2) {
      nameRegexes.push(new RegExp(`\\b${escapeRegExp(person.name.trim())}\\b`, "i"));
    }
  }

  return {
    raw,
    people: includedPeople,
    byDiscordId,
    byImessageHandle,
    nameRegexes,
    imessageChatId: raw.imessageChatId ?? null,
  };
}

/**
 * Writes or updates data/people.json. `discovered` is an array of
 * { discordId, name, survivingCount }. Never overwrites existing entries;
 * on a second run, newly-discovered discordIds are appended with include:false
 * and a summary is printed instead of touching what's already there.
 */
function initOrUpdatePeopleConfig(discovered) {
  const configPath = peopleConfigPath();
  const exists = fs.existsSync(configPath);

  if (!exists) {
    const people = discovered.map((d, i) => ({
      id: i + 1,
      name: d.name,
      include: true,
      discordIds: [d.discordId],
      imessageHandles: [],
      messageCount: d.survivingCount,
    }));
    fs.writeFileSync(configPath, JSON.stringify({ people }, null, 2) + "\n");
    console.log(`Wrote data/people.json with ${people.length} discovered people (all include: true):`);
    for (const p of people) console.log(`  [${p.id}] ${p.name} — ${p.messageCount} surviving messages`);
    console.log(`\nEdit data/people.json to exclude anyone, merge duplicate accounts, or add imessageHandles.`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const people = raw.people || [];
  const knownDiscordIds = new Set(people.flatMap((p) => p.discordIds || []));
  const nextId = people.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;

  const newOnes = discovered.filter((d) => !knownDiscordIds.has(d.discordId));
  if (newOnes.length === 0) {
    console.log(`data/people.json already exists — no new Discord authors found beyond what's already listed.`);
    return;
  }

  let id = nextId;
  for (const d of newOnes) {
    people.push({
      id: id++,
      name: d.name,
      include: false,
      discordIds: [d.discordId],
      imessageHandles: [],
      messageCount: d.survivingCount,
    });
  }
  fs.writeFileSync(configPath, JSON.stringify({ ...raw, people }, null, 2) + "\n");
  console.log(`data/people.json already exists. Found ${newOnes.length} new Discord author(s), added as include:false:`);
  for (const d of newOnes) console.log(`  ${d.name} (${d.discordId}) — ${d.survivingCount} surviving messages`);
  console.log(`\nEdit data/people.json if any of these should be included or merged into an existing person.`);
}

// ---------- filtering ----------

/**
 * Applies shared content filters + normalization to a single candidate message.
 * `msg`: { id, personId, rawContent, timestampMs, source, laughReacts, otherReacts }
 * Returns the normalized candidate object, or null (with the reason pushed onto `dropped`).
 */
function filterMessage(msg, { nameRegexes, seenContent, dropped }) {
  if (msg.personId == null) {
    dropped.excluded_person = (dropped.excluded_person || 0) + 1;
    return null;
  }
  const rawContent = (msg.rawContent || "").trim();
  if (!rawContent || URL_RE.test(rawContent)) {
    dropped.empty_or_url = (dropped.empty_or_url || 0) + 1;
    return null;
  }
  const wordCount = rawContent.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4 || rawContent.length < 15) {
    dropped.too_short = (dropped.too_short || 0) + 1;
    return null;
  }
  if (rawContent.length > 280) {
    dropped.too_long = (dropped.too_long || 0) + 1;
    return null;
  }
  if (COMMAND_PREFIX_RE.test(rawContent)) {
    dropped.command = (dropped.command || 0) + 1;
    return null;
  }
  if (nonAlphaRatio(rawContent) > 0.6) {
    dropped.non_alpha = (dropped.non_alpha || 0) + 1;
    return null;
  }
  if (nameRegexes.some((re) => re.test(rawContent))) {
    dropped.self_identifying = (dropped.self_identifying || 0) + 1;
    return null;
  }
  const normalized = normalizeContent(rawContent);
  const dedupeKey = normalized.toLowerCase();
  if (seenContent.has(dedupeKey)) {
    dropped.duplicate = (dropped.duplicate || 0) + 1;
    return null;
  }
  seenContent.add(dedupeKey);

  return {
    id: msg.id,
    personId: msg.personId,
    content: normalized,
    timestampMs: msg.timestampMs,
    sentAt: new Date(msg.timestampMs).toISOString(),
    source: msg.source,
    laughReacts: msg.laughReacts || 0,
    otherReacts: msg.otherReacts || 0,
  };
}

/**
 * Computes reply-burst signal for `kept` candidates against `stream` (all messages
 * from the SAME source, sorted by timestampMs, shape {personId, content, timestampMs}).
 * Kept and stream must come from the same conversation/source — bursts don't cross sources.
 */
function computeReplyBursts(kept, stream) {
  const WINDOW_MS = 3 * 60 * 1000;
  const bursts = new Map();
  let streamIdx = 0;
  for (const q of kept) {
    while (streamIdx < stream.length && stream[streamIdx].timestampMs <= q.timestampMs) streamIdx++;
    let count = 0;
    let laugh = false;
    for (let i = streamIdx; i < stream.length && stream[i].timestampMs <= q.timestampMs + WINDOW_MS; i++) {
      if (stream[i].personId === q.personId) continue;
      count++;
      if (LAUGH_RE.test(stream[i].content)) laugh = true;
    }
    bursts.set(q.id, { count, laugh });
  }
  return bursts;
}

/** Mutates `kept` items in place, setting rawScore/interestScore/humorScore (humorScore is a fallback, overwritten by LLM stages). */
function heuristicScore(kept, burstsBySource) {
  const raws = kept.map((q) => {
    const burst = (burstsBySource.get(q.source) || new Map()).get(q.id) || { count: 0, laugh: false };
    const lengthBonus = q.content.length >= 30 && q.content.length <= 180 ? 1 : 0;
    return 4 * burst.count + (burst.laugh ? 10 : 0) + 8 * q.otherReacts + 10 * q.laughReacts + 4 * lengthBonus;
  });
  const percentiles = percentileNormalize(raws);
  kept.forEach((q, i) => {
    q.rawScore = raws[i];
    q.interestScore = percentiles[i];
    q.humorScore = percentiles[i];
  });
}

// ---------- two-stage LLM curation ----------

async function checkOllamaAvailable() {
  try {
    const res = await fetch(OLLAMA_TAGS_URL);
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaGenerate(prompt, model) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data.response || "";
}

async function stageAGate(content, model) {
  const prompt =
    `You will see a single chat message with NO other context. Decide if it makes COMPLETE sense entirely ` +
    `on its own: no missing references to earlier conversation (words like "that", "he", "it", "this" pointing ` +
    `to something unstated), no logistics questions ("you coming?", "what time"), and it is not an answer to a ` +
    `question we can't see. Reply with exactly one word: YES or NO.\n\n` +
    `Message: "${content.replace(/"/g, "'")}"`;
  const response = await ollamaGenerate(prompt, model);
  return /\byes\b/i.test(response);
}

async function stageBRating(content, model) {
  const prompt =
    `We're building a party game: friends are shown a chat message with no context and have to guess which ` +
    `group member said it. Rate how funny or entertaining this message would be as a standalone quote in that ` +
    `game, from 0 (boring) to 10 (hilarious). Favor one-liners, unhinged outbursts, absurd declarations, and ` +
    `strong opinions stated with total conviction. Score 0-2 for mundane conversation, plain questions, plans, ` +
    `or generic reactions.\n\n` +
    `Examples:\n` +
    `"I explained to the police officer that time is a construct and he still gave me the ticket" -> 9\n` +
    `"genuinely feel like garlic bread is the best thing humanity has ever created" -> 6\n` +
    `"what time are we meeting tomorrow" -> 1\n` +
    `"yeah that's exactly what happened to me too lol" -> 1\n\n` +
    `Reply with ONLY the number, nothing else.\n\n` +
    `Message: "${content.replace(/"/g, "'")}"`;
  const response = await ollamaGenerate(prompt, model);
  const match = response.match(/-?\d+(\.\d+)?/);
  if (!match) throw new Error(`Could not parse a number from Ollama response: "${response}"`);
  return Math.max(0, Math.min(10, parseFloat(match[0])));
}

/** Mutates `kept` items' humorScore in place. `cacheDb` must already have the llm_cache table. */
async function twoStageLlmRank(kept, { model, candidates, cacheDb }) {
  const available = await checkOllamaAvailable();
  if (!available) {
    console.warn(`\n⚠ Ollama not reachable at ${OLLAMA_URL} — skipping LLM ranking, using heuristic scores only.`);
    return;
  }

  const pool = [...kept].sort((a, b) => b.rawScore - a.rawScore).slice(0, candidates);

  const getCached = cacheDb.prepare(
    "SELECT rating FROM llm_cache WHERE message_id = ? AND model = ? AND prompt_version = ? AND stage = ?"
  );
  const setCached = cacheDb.prepare(
    "INSERT INTO llm_cache (message_id, model, prompt_version, stage, rating, rated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(message_id, model, prompt_version, stage) DO UPDATE SET rating = excluded.rating, rated_at = excluded.rated_at"
  );

  let gatePassed = 0;
  let gateFailed = 0;
  let failed = 0;
  let done = 0;
  const total = pool.length;

  for (const q of pool) {
    let passedGate;
    const gateRow = getCached.get(q.id, model, PROMPT_VERSION, "gate");
    if (gateRow) {
      passedGate = gateRow.rating === 1;
    } else {
      try {
        passedGate = await stageAGate(q.content, model);
        setCached.run(q.id, model, PROMPT_VERSION, "gate", passedGate ? 1 : 0, new Date().toISOString());
      } catch {
        failed++;
        done++;
        continue;
      }
    }

    if (!passedGate) {
      gateFailed++;
      q.humorScore = Math.min(q.interestScore, 20);
    } else {
      gatePassed++;
      const ratingRow = getCached.get(q.id, model, PROMPT_VERSION, "rating");
      let rating;
      if (ratingRow) {
        rating = ratingRow.rating;
      } else {
        try {
          rating = await stageBRating(q.content, model);
          setCached.run(q.id, model, PROMPT_VERSION, "rating", rating, new Date().toISOString());
        } catch {
          failed++;
          done++;
          continue;
        }
      }
      q.humorScore = Math.round(0.15 * q.interestScore + 0.85 * rating * 10);
    }

    done++;
    if (done % 50 === 0 || done === total) {
      process.stdout.write(
        `\r  LLM curation: ${done}/${total} (${gatePassed} passed standalone gate, ${gateFailed} filtered out, ${failed} failed)`
      );
    }
  }
  process.stdout.write("\n");
}

// ---------- database ----------

function buildDatabase(dbPath, people, kept) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      message_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      stage TEXT NOT NULL,
      rating REAL NOT NULL,
      rated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, model, prompt_version, stage)
    );
    DROP TABLE IF EXISTS quotes;
    DROP TABLE IF EXISTS people;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id),
      content TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      source TEXT NOT NULL,
      humor_score REAL NOT NULL,
      interest_score REAL NOT NULL,
      times_played INTEGER NOT NULL DEFAULT 0
    );
  `);

  const insertPerson = db.prepare("INSERT INTO people (id, name) VALUES (?, ?)");
  const insertQuote = db.prepare(
    "INSERT INTO quotes (id, person_id, content, sent_at, source, humor_score, interest_score) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (const p of people) insertPerson.run(p.id, p.name);
    for (const q of kept) insertQuote.run(q.id, q.personId, q.content, q.sentAt, q.source, q.humorScore, q.interestScore);
  });
  insertAll();

  return db;
}

function updateHumorScores(db, kept) {
  const update = db.prepare("UPDATE quotes SET humor_score = ? WHERE id = ?");
  const updateAll = db.transaction(() => {
    for (const q of kept) update.run(q.humorScore, q.id);
  });
  updateAll();
}

function printPreview(kept, n, peopleById) {
  console.log(`\nTop ${n} by humor_score (review this yourself in your own terminal):`);
  const top = [...kept].sort((a, b) => b.humorScore - a.humorScore).slice(0, n);
  for (const q of top) {
    const name = peopleById.get(q.personId) || "?";
    console.log(`  [${q.humorScore.toFixed(0)}] (${q.source}) ${name}: ${q.content}`);
  }
}

module.exports = {
  PROMPT_VERSION,
  LAUGH_RE,
  escapeRegExp,
  normalizeContent,
  nonAlphaRatio,
  percentileNormalize,
  peopleConfigPath,
  loadPeopleConfig,
  initOrUpdatePeopleConfig,
  filterMessage,
  computeReplyBursts,
  heuristicScore,
  checkOllamaAvailable,
  twoStageLlmRank,
  buildDatabase,
  updateHumorScores,
  printPreview,
};
