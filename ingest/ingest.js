// Offline pipeline: DiscordChatExporter JSON -> data/quotes.db
// Usage: node ingest/ingest.js data/export1.json [data/export2.json ...] [--model=llama3.1:8b] [--no-ollama] [--candidates=800]
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const OLLAMA_URL = "http://localhost:11434/api/generate";

function parseArgs(argv) {
  const files = [];
  let model = "llama3.1:8b";
  let useOllama = true;
  let candidates = 800;
  for (const arg of argv) {
    if (arg === "--no-ollama") useOllama = false;
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--candidates=")) candidates = parseInt(arg.slice("--candidates=".length), 10);
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else files.push(arg);
  }
  if (files.length === 0) {
    throw new Error("Usage: node ingest/ingest.js <export.json> [more.json ...] [--model=name] [--no-ollama]");
  }
  return { files, model, useOllama, candidates };
}

const LAUGH_RE = /\b(lm(a|f)o+|lo+l+|haha+|bruh+|wtf)\b|😂|💀|🤣/i;
const URL_RE = /https?:\/\//i;
const COMMAND_PREFIX_RE = /^[!/.\-]\w/;
const MENTION_RE = /<@!?(\d+)>/g;
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadExports(files) {
  const allMessages = [];
  let guildName = null;
  let channelName = null;
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    guildName = guildName || (data.guild && data.guild.name) || (data.channel && data.channel.name);
    channelName = channelName || (data.channel && data.channel.name);
    if (!Array.isArray(data.messages)) {
      throw new Error(`${file}: no "messages" array found — is this a DiscordChatExporter JSON export?`);
    }
    allMessages.push(...data.messages);
  }
  allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return { messages: allMessages, guildName, channelName };
}

function collectDisplayNames(messages) {
  const names = new Set();
  for (const m of messages) {
    if (!m.author) continue;
    if (m.author.name) names.add(m.author.name);
    if (m.author.nickname) names.add(m.author.nickname);
  }
  // Longest names first so word-boundary matching doesn't get short-circuited by a substring match order.
  return [...names]
    .filter((n) => n && n.trim().length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i"));
}

function normalizeContent(content) {
  let text = content.replace(MENTION_RE, "@someone");
  text = text.replace(CUSTOM_EMOJI_RE, ":$1:");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function isSelfIdentifying(content, nameRegexes) {
  return nameRegexes.some((re) => re.test(content));
}

function nonAlphaRatio(content) {
  const chars = content.replace(/\s/g, "");
  if (chars.length === 0) return 1;
  const alpha = chars.replace(/[^a-zA-Z]/g, "");
  return 1 - alpha.length / chars.length;
}

function filterMessages(messages, nameRegexes) {
  const seenContent = new Set();
  const kept = [];
  let dropped = {
    bot: 0,
    type: 0,
    empty_or_url: 0,
    too_short: 0,
    too_long: 0,
    command: 0,
    non_alpha: 0,
    self_identifying: 0,
    duplicate: 0,
  };

  for (const m of messages) {
    if (!m.author || m.author.isBot) {
      dropped.bot++;
      continue;
    }
    if (m.type !== "Default" && m.type !== "Reply") {
      dropped.type++;
      continue;
    }
    const rawContent = (m.content || "").trim();
    if (!rawContent || URL_RE.test(rawContent)) {
      dropped.empty_or_url++;
      continue;
    }
    const wordCount = rawContent.split(/\s+/).filter(Boolean).length;
    if (wordCount < 4 || rawContent.length < 15) {
      dropped.too_short++;
      continue;
    }
    if (rawContent.length > 280) {
      dropped.too_long++;
      continue;
    }
    if (COMMAND_PREFIX_RE.test(rawContent)) {
      dropped.command++;
      continue;
    }
    if (nonAlphaRatio(rawContent) > 0.6) {
      dropped.non_alpha++;
      continue;
    }
    if (isSelfIdentifying(rawContent, nameRegexes)) {
      dropped.self_identifying++;
      continue;
    }
    const normalized = normalizeContent(rawContent);
    const dedupeKey = normalized.toLowerCase();
    if (seenContent.has(dedupeKey)) {
      dropped.duplicate++;
      continue;
    }
    seenContent.add(dedupeKey);
    kept.push({
      id: m.id,
      authorId: m.author.id,
      authorName: m.author.nickname || m.author.name,
      content: normalized,
      timestamp: m.timestamp,
      timestampMs: new Date(m.timestamp).getTime(),
      reactions: Array.isArray(m.reactions) ? m.reactions : [],
    });
  }

  return { kept, dropped };
}

function enforceAuthorThreshold(kept, minMessages) {
  const counts = new Map();
  for (const q of kept) counts.set(q.authorId, (counts.get(q.authorId) || 0) + 1);
  const eligibleAuthors = new Set([...counts.entries()].filter(([, c]) => c >= minMessages).map(([id]) => id));
  const filtered = kept.filter((q) => eligibleAuthors.has(q.authorId));
  return { filtered, authorCounts: counts, eligibleAuthors };
}

function computeReplyBursts(kept, allMessagesSorted) {
  // For each kept quote, count messages by OTHER authors within 3 minutes after it,
  // using the full (unfiltered, non-bot, Default/Reply) message stream for accurate context.
  const stream = allMessagesSorted
    .filter((m) => m.author && !m.author.isBot && (m.type === "Default" || m.type === "Reply"))
    .map((m) => ({
      authorId: m.author.id,
      content: m.content || "",
      timestampMs: new Date(m.timestamp).getTime(),
    }));

  const WINDOW_MS = 3 * 60 * 1000;
  const bursts = new Map(); // quote id -> { count, laugh }

  // Two-pointer sweep since both arrays are timestamp-sorted.
  let streamIdx = 0;
  for (const q of kept) {
    while (streamIdx < stream.length && stream[streamIdx].timestampMs <= q.timestampMs) streamIdx++;
    let count = 0;
    let laugh = false;
    for (let i = streamIdx; i < stream.length && stream[i].timestampMs <= q.timestampMs + WINDOW_MS; i++) {
      if (stream[i].authorId === q.authorId) continue;
      count++;
      if (LAUGH_RE.test(stream[i].content)) laugh = true;
    }
    bursts.set(q.id, { count, laugh });
  }
  return bursts;
}

function percentileNormalize(values) {
  const sorted = [...values].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const result = new Array(values.length);
  const n = sorted.length;
  sorted.forEach(([, originalIdx], rank) => {
    result[originalIdx] = n <= 1 ? 100 : Math.round((rank / (n - 1)) * 100);
  });
  return result;
}

function heuristicScore(kept, bursts) {
  const raws = kept.map((q) => {
    const burst = bursts.get(q.id) || { count: 0, laugh: false };
    const reacts = q.reactions.reduce((s, r) => s + (r.count || 0), 0);
    const lengthBonus = q.content.length >= 30 && q.content.length <= 180 ? 1 : 0;
    return 4 * burst.count + (burst.laugh ? 10 : 0) + 8 * reacts + 4 * lengthBonus;
  });
  const percentiles = percentileNormalize(raws);
  kept.forEach((q, i) => {
    q.rawScore = raws[i];
    q.interestScore = percentiles[i];
    q.humorScore = percentiles[i]; // overwritten for LLM-rated candidates below
  });
}

async function rateWithOllama(content, model) {
  const prompt =
    "Rate how funny or quotable this out-of-context chat message is, on a scale of 0 (boring/mundane) to 10 (hilarious/very quotable). " +
    'Reply with ONLY the number, nothing else.\n\nMessage: "' +
    content.replace(/"/g, "'") +
    '"';
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const match = (data.response || "").match(/-?\d+(\.\d+)?/);
  if (!match) throw new Error(`Could not parse a number from Ollama response: "${data.response}"`);
  const num = parseFloat(match[0]);
  return Math.max(0, Math.min(10, num));
}

async function checkOllamaAvailable() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    return res.ok;
  } catch {
    return false;
  }
}

async function llmRankTopCandidates(kept, { model, candidates, cacheDb }) {
  const available = await checkOllamaAvailable();
  if (!available) {
    console.warn(`\n⚠ Ollama not reachable at ${OLLAMA_URL} — skipping LLM ranking, using heuristic scores only.`);
    return;
  }

  const sorted = [...kept].sort((a, b) => b.rawScore - a.rawScore);
  const pool = sorted.slice(0, candidates);

  const getCached = cacheDb.prepare("SELECT rating FROM llm_cache WHERE message_id = ? AND model = ?");
  const setCached = cacheDb.prepare(
    "INSERT INTO llm_cache (message_id, model, rating, rated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(message_id, model) DO UPDATE SET rating = excluded.rating, rated_at = excluded.rated_at"
  );

  let done = 0;
  let cached = 0;
  let failed = 0;
  const total = pool.length;

  for (const q of pool) {
    const row = getCached.get(q.id, model);
    let rating;
    if (row) {
      rating = row.rating;
      cached++;
    } else {
      try {
        rating = await rateWithOllama(q.content, model);
        setCached.run(q.id, model, rating, new Date().toISOString());
      } catch (err) {
        failed++;
        rating = null;
      }
    }
    if (rating !== null) {
      q.humorScore = Math.round(0.3 * q.interestScore + 0.7 * rating * 10);
    }
    done++;
    if (done % 50 === 0 || done === total) {
      process.stdout.write(`\r  LLM ranking: ${done}/${total} (${cached} cached, ${failed} failed)`);
    }
  }
  process.stdout.write("\n");
}

function buildDatabase(dbPath, kept, authorCounts, eligibleAuthors, allMessagesForAuthorLookup) {
  if (fs.existsSync(dbPath)) {
    // Preserve the llm_cache table across re-runs by not deleting the file;
    // just drop and recreate the tables we regenerate.
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      message_id TEXT NOT NULL,
      model TEXT NOT NULL,
      rating REAL NOT NULL,
      rated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, model)
    );
    DROP TABLE IF EXISTS quotes;
    DROP TABLE IF EXISTS authors;
    CREATE TABLE authors (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES authors(id),
      content TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      humor_score REAL NOT NULL,
      interest_score REAL NOT NULL,
      times_played INTEGER NOT NULL DEFAULT 0
    );
  `);

  const authorNameById = new Map();
  for (const m of allMessagesForAuthorLookup) {
    if (m.author && eligibleAuthors.has(m.author.id) && !authorNameById.has(m.author.id)) {
      authorNameById.set(m.author.id, m.author.nickname || m.author.name);
    }
  }

  const insertAuthor = db.prepare("INSERT INTO authors (id, display_name) VALUES (?, ?)");
  const insertQuote = db.prepare(
    "INSERT INTO quotes (id, author_id, content, sent_at, humor_score, interest_score) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (const id of eligibleAuthors) {
      insertAuthor.run(id, authorNameById.get(id) || "Unknown");
    }
    for (const q of kept) {
      insertQuote.run(q.id, q.authorId, q.content, q.timestamp, q.humorScore, q.interestScore);
    }
  });
  insertAll();

  return db;
}

async function main() {
  const { files, model, useOllama, candidates } = parseArgs(process.argv.slice(2));

  console.log(`Reading ${files.length} export file(s)...`);
  const { messages, guildName, channelName } = loadExports(files);
  console.log(`Loaded ${messages.length} raw messages from "${guildName || "?"}" / "${channelName || "?"}"`);

  const nameRegexes = collectDisplayNames(messages);
  const { kept: filteredMessages, dropped } = filterMessages(messages, nameRegexes);

  const MIN_MESSAGES_PER_AUTHOR = 20;
  const { filtered: kept, authorCounts, eligibleAuthors } = enforceAuthorThreshold(
    filteredMessages,
    MIN_MESSAGES_PER_AUTHOR
  );

  console.log(`\nFiltering summary:`);
  console.log(`  kept: ${kept.length} / ${messages.length}`);
  for (const [reason, count] of Object.entries(dropped)) {
    console.log(`  dropped (${reason}): ${count}`);
  }
  console.log(
    `  dropped (author below ${MIN_MESSAGES_PER_AUTHOR}-message threshold): ${filteredMessages.length - kept.length}`
  );
  console.log(`  eligible authors: ${eligibleAuthors.size}`);

  if (kept.length === 0) {
    console.error("No quotes survived filtering — check the export file and filter thresholds.");
    process.exit(1);
  }

  console.log(`\nScoring (pass 1: heuristic)...`);
  const bursts = computeReplyBursts(kept, messages);
  heuristicScore(kept, bursts);

  const dbPath = path.join(__dirname, "..", "data", "quotes.db");
  const db = buildDatabase(dbPath, kept, authorCounts, eligibleAuthors, messages);

  if (useOllama) {
    console.log(`\nScoring (pass 2: local LLM via Ollama, model=${model}, candidates=${candidates})...`);
    await llmRankTopCandidates(kept, { model, candidates, cacheDb: db });

    // humorScore may have changed for LLM-rated quotes; write final values.
    const updateScore = db.prepare("UPDATE quotes SET humor_score = ? WHERE id = ?");
    const updateAll = db.transaction(() => {
      for (const q of kept) updateScore.run(q.humorScore, q.id);
    });
    updateAll();
  } else {
    console.log(`\nSkipping LLM ranking (--no-ollama) — humor_score falls back to heuristic percentile.`);
  }

  db.close();

  console.log(`\nWrote ${kept.length} quotes from ${eligibleAuthors.size} authors to ${dbPath}`);

  console.log(`\nTop 10 by humor_score (sanity check — review this yourself in your own terminal):`);
  const top10 = [...kept].sort((a, b) => b.humorScore - a.humorScore).slice(0, 10);
  for (const q of top10) {
    console.log(`  [${q.humorScore.toFixed(0)}] ${q.authorName}: ${q.content}`);
  }
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
