// Discord adapter + CLI entry point for the ingest pipeline.
//
// Usage:
//   node ingest/ingest.js --init-config <export.json ...>       write/update data/people.json, then stop
//   node ingest/ingest.js --list-chats [--backup=<path>]        list iMessage group chats, then stop
//   node ingest/ingest.js <export.json ...> [options]           run the full pipeline
//
// Options: --model=qwen2.5:7b-instruct --no-ollama --candidates=2000 --preview=10
"use strict";

const fs = require("fs");
const path = require("path");
const common = require("./common");

const LAUGH_EMOJI_RE = /lul|kek|lmao|laugh|joy|cry.?laugh|pog|haha/i;
const LAUGH_EMOJI_NAMES = new Set(["😂", "🤣", "💀", "😭", "🫠", "😹"]);

function parseArgs(argv) {
  const files = [];
  let model = "qwen2.5:7b-instruct";
  let useOllama = true;
  let candidates = 2000;
  let preview = 10;
  let initConfig = false;
  let listChats = false;
  let showChat = null;
  let backup = null;

  for (const arg of argv) {
    if (arg === "--no-ollama") useOllama = false;
    else if (arg === "--init-config") initConfig = true;
    else if (arg === "--list-chats") listChats = true;
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--candidates=")) candidates = parseInt(arg.slice("--candidates=".length), 10);
    else if (arg.startsWith("--preview=")) preview = parseInt(arg.slice("--preview=".length), 10);
    else if (arg.startsWith("--backup=")) backup = arg.slice("--backup=".length);
    else if (arg.startsWith("--show-chat=")) showChat = parseInt(arg.slice("--show-chat=".length), 10);
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else files.push(arg);
  }
  return { files, model, useOllama, candidates, preview, initConfig, listChats, showChat, backup };
}

function loadDiscordExports(files) {
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

function classifyReactions(reactions) {
  let laugh = 0;
  let other = 0;
  for (const r of Array.isArray(reactions) ? reactions : []) {
    const name = (r.emoji && r.emoji.name) || "";
    const count = r.count || 0;
    if (LAUGH_EMOJI_NAMES.has(name) || LAUGH_EMOJI_RE.test(name)) laugh += count;
    else other += count;
  }
  return { laugh, other };
}

/** Discord-specific structural pre-filter (bot / message type) before the shared content filters apply. */
function discordStructuralStream(messages) {
  return messages.filter((m) => m.author && !m.author.isBot && (m.type === "Default" || m.type === "Reply"));
}

// ---------- --init-config ----------

function runInitConfig(files) {
  const { messages, guildName, channelName } = loadDiscordExports(files);
  console.log(`Read ${messages.length} raw messages from "${guildName || "?"}" / "${channelName || "?"}"`);

  const structural = discordStructuralStream(messages);

  const nameSet = new Set();
  for (const m of structural) {
    if (m.author.name) nameSet.add(m.author.name);
    if (m.author.nickname) nameSet.add(m.author.nickname);
  }
  const nameRegexes = [...nameSet]
    .filter((n) => n && n.trim().length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((n) => new RegExp(`\\b${common.escapeRegExp(n)}\\b`, "i"));

  const seenContent = new Set();
  const dropped = {};
  const survivedCountByAuthor = new Map();
  const nameByAuthor = new Map();

  for (const m of structural) {
    nameByAuthor.set(m.author.id, m.author.nickname || m.author.name);
    const candidate = common.filterMessage(
      {
        id: `disc-${m.id}`,
        personId: m.author.id, // stand-in identity, just for counting at this stage
        rawContent: m.content,
        timestampMs: new Date(m.timestamp).getTime(),
        source: "discord",
      },
      { nameRegexes, seenContent, dropped }
    );
    if (candidate) survivedCountByAuthor.set(m.author.id, (survivedCountByAuthor.get(m.author.id) || 0) + 1);
  }

  const discovered = [...nameByAuthor.entries()].map(([discordId, name]) => ({
    discordId,
    name,
    survivingCount: survivedCountByAuthor.get(discordId) || 0,
  }));

  common.initOrUpdatePeopleConfig(discovered);
}

// ---------- main pipeline ----------

async function runPipeline({ files, model, useOllama, candidates, preview }) {
  const peopleConfig = common.loadPeopleConfig();
  if (peopleConfig.people.length === 0) {
    console.error("No included people in data/people.json (everyone has include:false). Nothing to do.");
    process.exit(1);
  }

  const seenContent = new Set();
  const dropped = {};
  const burstsBySource = new Map();
  let kept = [];

  if (files.length > 0) {
    console.log(`Reading ${files.length} Discord export file(s)...`);
    const { messages, guildName, channelName } = loadDiscordExports(files);
    console.log(`Loaded ${messages.length} raw messages from "${guildName || "?"}" / "${channelName || "?"}"`);

    const structural = discordStructuralStream(messages);
    dropped.bot_or_wrong_type = messages.length - structural.length;

    const discordKept = [];
    for (const m of structural) {
      const { laugh, other } = classifyReactions(m.reactions);
      const candidate = common.filterMessage(
        {
          id: `disc-${m.id}`,
          personId: peopleConfig.byDiscordId.get(m.author.id) ?? null,
          rawContent: m.content,
          timestampMs: new Date(m.timestamp).getTime(),
          source: "discord",
          laughReacts: laugh,
          otherReacts: other,
        },
        { nameRegexes: peopleConfig.nameRegexes, seenContent, dropped }
      );
      if (candidate) discordKept.push(candidate);
    }
    kept.push(...discordKept);

    const stream = structural.map((m) => ({
      personId: peopleConfig.byDiscordId.get(m.author.id) ?? null,
      content: m.content || "",
      timestampMs: new Date(m.timestamp).getTime(),
    }));
    burstsBySource.set("discord", common.computeReplyBursts(discordKept, stream));
  } else {
    console.log("No Discord export file given — skipping Discord source.");
  }

  if (peopleConfig.imessageChatId != null) {
    const dbPath = path.join(__dirname, "..", "data", "sms.db");
    if (!fs.existsSync(dbPath)) {
      console.warn(
        `\n⚠ people.json has imessageChatId=${peopleConfig.imessageChatId} but data/sms.db is missing. ` +
          `Run "node ingest/ingest.js --list-chats" first to copy it in. Skipping iMessage source.`
      );
    } else {
      const imessage = require("./imessage");
      console.log(`\nExtracting iMessage chat ${peopleConfig.imessageChatId}...`);
      const result = imessage.extractAndFilter(peopleConfig, { dropped, seenContent });
      kept.push(...result.kept);
      burstsBySource.set("imessage", common.computeReplyBursts(result.kept, result.stream));
      console.log(`  iMessage: kept ${result.kept.length}, skipped ${result.skippedNoText} with no extractable text`);
      if (result.unresolvedHandles.size > 0) {
        console.log(`  Unresolved handles (add to people.json to include):`);
        for (const [handle, count] of result.unresolvedHandles) console.log(`    ${handle} — ${count} messages`);
      }
    }
  }

  console.log(`\nFiltering summary:`);
  console.log(`  kept: ${kept.length}`);
  for (const [reason, count] of Object.entries(dropped)) {
    console.log(`  dropped (${reason}): ${count}`);
  }

  if (kept.length === 0) {
    console.error("No quotes survived filtering — check people.json and the source files.");
    process.exit(1);
  }

  const countsByPerson = new Map();
  for (const q of kept) countsByPerson.set(q.personId, (countsByPerson.get(q.personId) || 0) + 1);
  for (const p of peopleConfig.people) {
    const n = countsByPerson.get(p.id) || 0;
    if (n < 20) console.warn(`⚠ ${p.name} has only ${n} surviving quotes (< 20) — may barely appear in games.`);
  }

  console.log(`\nScoring (pass 1: heuristic)...`);
  common.heuristicScore(kept, burstsBySource);

  const dbPath = path.join(__dirname, "..", "data", "quotes.db");
  const db = common.buildDatabase(dbPath, peopleConfig.people, kept);

  if (useOllama) {
    console.log(`\nScoring (pass 2: two-stage local LLM curation via Ollama, model=${model}, candidates=${candidates})...`);
    await common.twoStageLlmRank(kept, { model, candidates, cacheDb: db });
    common.updateHumorScores(db, kept);
  } else {
    console.log(`\nSkipping LLM curation (--no-ollama) — humor_score falls back to heuristic percentile.`);
  }

  db.close();

  console.log(`\nWrote ${kept.length} quotes from ${peopleConfig.people.length} people to ${dbPath}`);
  const peopleById = new Map(peopleConfig.people.map((p) => [p.id, p.name]));
  common.printPreview(kept, preview, peopleById);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.initConfig) {
    if (args.files.length === 0) {
      throw new Error("Usage: node ingest/ingest.js --init-config <export.json> [more.json ...]");
    }
    runInitConfig(args.files);
    return;
  }

  if (args.listChats) {
    const imessage = require("./imessage");
    imessage.listChats({ backupPathOverride: args.backup });
    return;
  }

  if (args.showChat != null) {
    const imessage = require("./imessage");
    imessage.showChat(args.showChat, { backupPathOverride: args.backup });
    return;
  }

  await runPipeline(args);
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exit(1);
});
