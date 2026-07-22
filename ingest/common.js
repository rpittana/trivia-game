// Shared pipeline: filtering, normalization, scoring, LLM curation, and DB writing.
// Used by both ingest/ingest.js (Discord adapter) and ingest/imessage.js (iMessage adapter).
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";

// Bump whenever a Stage A/B prompt string changes below, so stale cached ratings are re-run.
const PROMPT_VERSION = "v5";

const LAUGH_RE = /\b(lm(a|f)o+|lo+l+|haha+|bruh+|wtf)\b|😂|💀|🤣/i;
const URL_RE = /https?:\/\//i;
const COMMAND_PREFIX_RE = /^[!/.\-]\w/;
const MENTION_RE = /<@!?(\d+)>/g;
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

// Okabe-Ito colorblind-safe palette, last swapped for a mid-gray (pure black disappears on the dark UI).
const COLOR_PALETTE = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"];

function colorForPersonId(id) {
  return COLOR_PALETTE[(id - 1) % COLOR_PALETTE.length];
}

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
    includedPeople.push({ id: person.id, name: person.name, color: person.color || colorForPersonId(person.id) });
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
      color: colorForPersonId(i + 1),
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
      id,
      name: d.name,
      include: false,
      discordIds: [d.discordId],
      imessageHandles: [],
      color: colorForPersonId(id),
      messageCount: d.survivingCount,
    });
    id++;
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
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, seed: 7 } }),
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, seed: 7 } }),
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
    `question we can't see. Also reply NO if the message is a reaction to, correction of, disagreement with, ` +
    `or continuation of some unseen prior statement — it must stand entirely on its own. Reply with exactly ` +
    `one word: YES or NO.\n\n` +
    `question we can't see. Also reply NO if the message is a reaction to, correction of, disagreement with, ` +
    `or continuation of some unseen prior statement — it must stand entirely on its own. Reply with exactly ` +
    `one word: YES or NO.\n\n` +
    `Message: "${content.replace(/"/g, "'")}"`;
  const response = await ollamaGenerate(prompt, model);
  return /\byes\b/i.test(response);
}

async function stageBRating(content, model) {
  const prompt =
    `We're building a party game: friends are shown a chat message with no context and have to guess which ` +
    `group member said it. Rate how funny or entertaining this message would be as a standalone quote in that ` +
    `game, from 0 (boring) to 10 (hilarious).\n\n` +
    `Be a HARSH, discriminating critic. Most chat messages are NOT funny: the median message should score 1. ` +
    `Reserve 8-10 for messages so absurd, unhinged, or quotable that they'd be funny printed on a T-shirt out ` +
    `of nowhere. A plain statement, question, correction, complaint, or opinion about a game/show/plan is a ` +
    `0-2 even if it's emphatic, in all caps, or has swearing in it — intensity is not the same as funny. ` +
    `Fewer than 1 in 20 messages you see deserves higher than a 7.\n\n` +
    `game, from 0 (boring) to 10 (hilarious).\n\n` +
    `Be a HARSH, discriminating critic. Most chat messages are NOT funny: the median message should score 1. ` +
    `Reserve 8-10 for messages so absurd, unhinged, or quotable that they'd be funny printed on a T-shirt out ` +
    `of nowhere. A plain statement, question, correction, complaint, or opinion about a game/show/plan is a ` +
    `0-2 even if it's emphatic, in all caps, or has swearing in it — intensity is not the same as funny. ` +
    `Fewer than 1 in 20 messages you see deserves higher than a 7.\n\n` +
    `Examples:\n` +
    `"I explained to the police officer that time is a construct and he still gave me the ticket" -> 9\n` +
    `"genuinely feel like garlic bread is the best thing humanity has ever created" -> 6\n` +
    `"what time are we meeting tomorrow" -> 1\n` +
    `"yeah that's exactly what happened to me too lol" -> 1\n` +
    `"you don't have Minecraft" -> 1\n` +
    `"how does this company even make money" -> 1\n` +
    `"the shop is not the same thing" -> 0\n` +
    `"BREATH OF THE WILD" -> 2\n\n` +
    `"yeah that's exactly what happened to me too lol" -> 1\n` +
    `"you don't have Minecraft" -> 1\n` +
    `"how does this company even make money" -> 1\n` +
    `"the shop is not the same thing" -> 0\n` +
    `"BREATH OF THE WILD" -> 2\n\n` +
    `Reply with ONLY the number, nothing else.\n\n` +
    `Message: "${content.replace(/"/g, "'")}"`;
  const response = await ollamaGenerate(prompt, model);
  const match = response.match(/-?\d+(\.\d+)?/);
  if (!match) throw new Error(`Could not parse a number from Ollama response: "${response}"`);
  return Math.max(0, Math.min(10, parseFloat(match[0])));
}

/**
 * Picks the LLM candidate pool with an even split per source, so one source's
 * heuristic-score distribution (e.g. Discord's reply-burst signal running hotter
 * than iMessage's tapback signal) can't crowd the other out of curation entirely.
 * Any shortfall from a source with too few candidates is topped up from whichever
 * source has the next-best remaining quotes.
 */
function selectCandidatePool(kept, candidates) {
  const bySource = new Map();
  for (const q of kept) {
    if (!bySource.has(q.source)) bySource.set(q.source, []);
    bySource.get(q.source).push(q);
  }
  for (const list of bySource.values()) list.sort((a, b) => b.rawScore - a.rawScore);

  const sources = [...bySource.keys()];
  const perSourceTarget = Math.ceil(candidates / sources.length);

  const pool = [];
  const poolIds = new Set();
  for (const source of sources) {
    const take = bySource.get(source).slice(0, perSourceTarget);
    for (const q of take) {
      pool.push(q);
      poolIds.add(q.id);
    }
  }

  if (pool.length < candidates) {
    const remaining = kept.filter((q) => !poolIds.has(q.id)).sort((a, b) => b.rawScore - a.rawScore);
    pool.push(...remaining.slice(0, candidates - pool.length));
  }

  return pool.slice(0, candidates);
}

/**
 * Picks the LLM candidate pool with an even split per source, so one source's
 * heuristic-score distribution (e.g. Discord's reply-burst signal running hotter
 * than iMessage's tapback signal) can't crowd the other out of curation entirely.
 * Any shortfall from a source with too few candidates is topped up from whichever
 * source has the next-best remaining quotes.
 */
function selectCandidatePool(kept, candidates) {
  const bySource = new Map();
  for (const q of kept) {
    if (!bySource.has(q.source)) bySource.set(q.source, []);
    bySource.get(q.source).push(q);
  }
  for (const list of bySource.values()) list.sort((a, b) => b.rawScore - a.rawScore);

  const sources = [...bySource.keys()];
  const perSourceTarget = Math.ceil(candidates / sources.length);

  const pool = [];
  const poolIds = new Set();
  for (const source of sources) {
    const take = bySource.get(source).slice(0, perSourceTarget);
    for (const q of take) {
      pool.push(q);
      poolIds.add(q.id);
    }
  }

  if (pool.length < candidates) {
    const remaining = kept.filter((q) => !poolIds.has(q.id)).sort((a, b) => b.rawScore - a.rawScore);
    pool.push(...remaining.slice(0, candidates - pool.length));
  }

  return pool.slice(0, candidates);
}

/** Mutates `kept` items' humorScore in place. `cacheDb` must already have the llm_cache table. */
async function twoStageLlmRank(kept, { model, candidates, cacheDb }) {
  const available = await checkOllamaAvailable();
  if (!available) {
    console.warn(`\n⚠ Ollama not reachable at ${OLLAMA_URL} — skipping LLM ranking, using heuristic scores only.`);
    return;
  }

  const pool = selectCandidatePool(kept, candidates);
  const poolIds = new Set(pool.map((q) => q.id));

  // Only quotes an LLM actually verified as funny should be able to rank high. A quote
  // that was never evaluated (outside the candidate pool) keeps its heuristic-percentile
  // score, and since percentiles are spread evenly 0-100 by construction, hundreds of
  // purely-engaging-but-not-funny quotes would otherwise land in the "90s" by definition.
  // Cap them the same way a failed standalone-sense gate is capped.
  for (const q of kept) {
    if (!poolIds.has(q.id)) q.humorScore = Math.min(q.interestScore, 20);
  }

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
    -- Never dropped: votes and guessability stats must survive re-ingest.
    CREATE TABLE IF NOT EXISTS quote_feedback (
      message_id TEXT PRIMARY KEY,
      downvotes INTEGER NOT NULL DEFAULT 0,
      upvotes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS person_stats (
      person_id INTEGER PRIMARY KEY,
      quotes_shown INTEGER NOT NULL DEFAULT 0,
      total_guesses INTEGER NOT NULL DEFAULT 0,
      correct_guesses INTEGER NOT NULL DEFAULT 0
    );
    DROP TABLE IF EXISTS quotes;
    DROP TABLE IF EXISTS people;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL
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

  // Guarded migration for a quote_feedback table created before `upvotes` existed.
  const feedbackCols = db.prepare("PRAGMA table_info(quote_feedback)").all().map((c) => c.name);
  if (!feedbackCols.includes("upvotes")) {
    db.exec("ALTER TABLE quote_feedback ADD COLUMN upvotes INTEGER NOT NULL DEFAULT 0");
  }

  const insertPerson = db.prepare("INSERT INTO people (id, name, color) VALUES (?, ?, ?)");
  const insertQuote = db.prepare(
    "INSERT INTO quotes (id, person_id, content, sent_at, source, humor_score, interest_score) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (const p of people) insertPerson.run(p.id, p.name, p.color || colorForPersonId(p.id));
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

// ---------- vote-driven curation ----------
//
// The local LLM's weights can't be fine-tuned by this app, and real chat text
// never goes into a prompt as a few-shot example (that's the privacy rule from
// the v3 incident). Instead, human up/downvotes are a persistent scoring signal
// that permanently overrides the LLM's guess for that quote, compounding across
// every re-ingest — a quote the group keeps loving climbs, one they keep hating
// stays buried. This is the real human-in-the-loop "trainer": it adjusts scores,
// not model weights.

const UPVOTE_BONUS = 8;
const DOWNVOTE_PENALTY = 15;

/** Mutates `kept` items' humorScore in place, folding in persisted votes. Call after LLM scoring, before the final DB write. */
function applyFeedbackFold(kept, db) {
  const getFeedback = db.prepare("SELECT upvotes, downvotes FROM quote_feedback WHERE message_id = ?");
  for (const q of kept) {
    const row = getFeedback.get(q.id);
    if (!row || (row.upvotes === 0 && row.downvotes === 0)) continue;
    const adjusted = q.humorScore + UPVOTE_BONUS * row.upvotes - DOWNVOTE_PENALTY * row.downvotes;
    q.humorScore = Math.max(0, Math.min(100, Math.round(adjusted)));
  }
}

/**
 * Prints (to the user's own terminal only) the quotes where your votes and the AI's
 * pre-fold rating disagreed most — e.g. the AI rated it high but you downvoted it, or
 * the AI dismissed it but you upvoted it. This is how you decide whether to nudge the
 * Stage B prompt. `preFoldScores` is a Map<messageId, humorScore> snapshotted before
 * applyFeedbackFold ran. The implementing agent must not read this output beyond
 * confirming the process exits 0 — it contains real quote text, for the user only.
 */
function printFeedbackReport(kept, preFoldScores, db, peopleById) {
  const getFeedback = db.prepare("SELECT upvotes, downvotes FROM quote_feedback WHERE message_id = ?");
  const disagreements = [];
  for (const q of kept) {
    const row = getFeedback.get(q.id);
    if (!row || (row.upvotes === 0 && row.downvotes === 0)) continue;
    const preScore = preFoldScores.get(q.id) ?? q.humorScore;
    const aiLikedYouDidnt = preScore >= 60 && row.downvotes > 0;
    const aiDismissedYouLiked = preScore <= 30 && row.upvotes > 0;
    if (aiLikedYouDidnt || aiDismissedYouLiked) {
      disagreements.push({
        q,
        preScore,
        upvotes: row.upvotes,
        downvotes: row.downvotes,
        reason: aiLikedYouDidnt ? "AI liked it, you downvoted" : "AI dismissed it, you upvoted",
      });
    }
  }
  disagreements.sort((a, b) => b.upvotes + b.downvotes - (a.upvotes + a.downvotes));

  console.log(`\nFeedback disagreement report — ${disagreements.length} quote(s) where your votes and the AI disagreed:`);
  if (disagreements.length === 0) {
    console.log(`  (none yet — vote 👍/👎 on quotes during a game, then re-run ingest with --feedback-report)`);
    return;
  }
  for (const d of disagreements) {
    const name = peopleById.get(d.q.personId) || "?";
    console.log(
      `  [AI rated ${d.preScore.toFixed(0)}, up:${d.upvotes} down:${d.downvotes}] (${d.reason}) ${name}: ${d.q.content}`
    );
  }
}

module.exports = {
  PROMPT_VERSION,
  LAUGH_RE,
  COLOR_PALETTE,
  colorForPersonId,
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
  applyFeedbackFold,
  printFeedbackReport,
};