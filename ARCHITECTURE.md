# Discord Quote Trivia — Architecture

A private, self-hosted multiplayer trivia game: players see a message from the group chat and guess **who sent it**. Built from a DiscordChatExporter JSON export. All data stays on the host machine.

**Audience for this doc:** an AI coding model implementing the project. Follow the contracts here exactly; anything not specified is implementer's choice, favoring simplicity.

---

## 1. High-level overview

Two separate programs sharing one folder:

```
discord-trivia/
├── ingest/               # OFFLINE pipeline, run once per export
│   └── ingest.js         # parses export JSON → scores quotes → quotes.db
├── server/
│   ├── server.js         # Express + Socket.IO game server
│   └── game.js           # pure game-state logic (no I/O — unit-testable)
├── public/               # static client, served by Express
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
│   ├── export.json       # raw DiscordChatExporter output (gitignored, never served)
│   └── quotes.db         # SQLite, produced by ingest (gitignored)
├── package.json
└── .gitignore            # must include data/
```

**Stack:** Node.js 20+, Express, Socket.IO, better-sqlite3. Client is vanilla HTML/JS/CSS (no framework, no build step). Nothing calls out to the internet.

**Why this shape:** the ingest step is slow/one-time and touches the raw private export; the game server only ever reads the sanitized `quotes.db`. The raw export is never served, never uploaded, never read by the game server.

---

## 2. Ingest pipeline (`ingest/ingest.js`)

CLI: `node ingest/ingest.js data/export.json [more-exports.json ...]`

DiscordChatExporter JSON shape (the relevant parts):

```jsonc
{
  "guild": { "name": "..." },
  "channel": { "name": "..." },
  "messages": [
    {
      "id": "1234567890",
      "type": "Default",            // also "Reply"; skip everything else
      "timestamp": "2024-03-01T12:34:56.789+00:00",
      "content": "the message text",
      "author": { "id": "...", "name": "roman", "nickname": "Roman", "isBot": false },
      "reactions": [ { "emoji": { "name": "😂" }, "count": 3 } ],
      "attachments": [ ... ],
      "embeds": [ ... ],
      "mentions": [ { "id": "...", "nickname": "..." } ]
    }
  ]
}
```

### 2.1 Filtering (drop a message if ANY apply)

- `author.isBot` is true, or `type` is not `Default`/`Reply`
- content is empty (image-only), or contains a URL (`https?://`)
- fewer than 4 words or fewer than 15 characters (too generic — "lol", "ok", "same")
- longer than 280 characters (unreadable on a game screen)
- starts with a command prefix (`!`, `/`, `.`, `-` followed by a word)
- content is >60% non-alphabetic (emoji spam, keysmash walls)
- **self-identifying:** content contains any participant's username or nickname (case-insensitive) or a raw `<@id>` mention — these give the answer away
- duplicate content (case-insensitive) of an already-kept message — keep only the first

Also normalize: replace `<@123>` / `<@!123>` mention tokens *that survive* with `@someone`, collapse whitespace, strip custom-emoji syntax `<:name:id>` down to `:name:`.

Only keep authors with **≥ 20 surviving messages**; players can't guess someone who barely talks, and they'd pollute the answer options.

### 2.2 Scoring — `humor_score` (0–100)

**This chat has almost no reactions**, so reactions cannot be the primary signal. Use engagement + local LLM instead.

**Pass 1 — heuristic pre-score** (cheap, ranks ALL messages):

```
reply_burst    = count of messages by OTHER authors within 3 minutes after this one
laugh_replies  = 1 if any of those replies matches /\b(lm(a|f)o+|lo+l|haha+|😂|💀|bruh|wtf)\b/i else 0
reacts         = total reaction count (rare but still worth points when present)
length_bonus   = 1 if 30–180 chars else 0          (the quotable sweet spot)

raw = 4*reply_burst + 10*laugh_replies + 8*reacts + 4*length_bonus
```

`interest_score` = percentile-normalized `raw` (engagement ≈ interesting).

**Pass 2 — local LLM ranking (primary humor signal, on by default):**
Take the top ~800 messages by pre-score, send each to local Ollama (`http://localhost:11434/api/generate`, default model `llama3.1:8b`, configurable via `--model`) asking for a 0–10 rating of how funny/quotable the message is out of context (respond with a single number only). `humor_score = 0.3*heuristic_percentile + 0.7*llm*10`. Log progress; cache LLM ratings in a table keyed by message id so re-runs are instant. If Ollama is unreachable, warn and fall back to heuristic-only (`--no-ollama` skips it deliberately). **Never** offer a cloud-API path — all ranking stays on the host machine.

Percentile-normalize both final scores to 0–100 across the corpus.

### 2.4 Output: `data/quotes.db` (SQLite)

```sql
CREATE TABLE authors (
  id TEXT PRIMARY KEY,          -- Discord user id
  display_name TEXT NOT NULL    -- nickname if set, else name
);
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,          -- Discord message id
  author_id TEXT NOT NULL REFERENCES authors(id),
  content TEXT NOT NULL,        -- normalized text
  sent_at TEXT NOT NULL,        -- ISO timestamp (shown after reveal: "sent March 2024")
  humor_score REAL NOT NULL,
  interest_score REAL NOT NULL,
  times_played INTEGER NOT NULL DEFAULT 0   -- incremented by the game server
);
```

Print a summary when done: messages read, kept, per-author counts, top-10 quotes preview so the user can sanity-check scoring.

---

## 3. Game server (`server/`)

Express serves `public/` and one Socket.IO namespace. Single lobby is fine (friends group), but implement rooms via a 4-letter code anyway — it's cheap and lets two games coexist.

### 3.1 Game flow

1. **Lobby** — first player to create a room is the host. Players join with room code + a display name. Host sees the player list and settings: number of rounds (default 15), seconds per round (default 20), quote pool (`funny` = top by humor_score, `interesting` = top by interest_score, `mixed` = default).
2. **Round** — server picks a quote (see 3.3), broadcasts it with the answer choices: **every tracked author in the DB** as buttons (group chats are small; if > 8 authors, send the true author + 7 random others, shuffled). Players lock in one guess; a countdown runs.
3. **Reveal** — when everyone has answered or time expires: show the true author, who guessed what, points gained, and the date the message was sent. Host clicks "next" (or auto-advance after 6 s).
4. **Game over** — final leaderboard, host can "play again" (same players, fresh quote draw).

### 3.2 Scoring

- Correct answer: **100 points** + speed bonus `round(50 * time_remaining / round_time)`.
- Wrong/no answer: 0. No negative points — keep it friendly.

### 3.3 Quote selection (the "no repeats" requirement)

- At game start, draw the full set of N quotes: filter by pool, `ORDER BY (score * (1.0 / (1 + times_played))) * (0.7 + 0.3*RANDOM-ish jitter) DESC LIMIT N`, i.e. prefer high scores, deprioritize quotes already played in past games, add jitter so consecutive games differ. Implement the jitter in JS, not SQL, for clarity.
- **Within a game:** quotes come from that pre-drawn set, so repeats are impossible by construction.
- **Across games:** increment `times_played` when a quote is shown. Decay, don't blacklist — with enough rounds the pool would otherwise run dry.
- Constraint: no author appears more than `ceil(N / distinct_authors) + 1` times in one game's draw (prevents a 15-round game that's 9 rounds of one loud friend).

### 3.4 Socket.IO event contract

Client → server:
| event | payload |
|---|---|
| `room:create` | `{ name }` → responds `{ roomCode }` |
| `room:join` | `{ roomCode, name }` |
| `game:start` | `{ rounds, roundSeconds, pool }` (host only) |
| `round:answer` | `{ authorId }` (first answer per round wins; ignore repeats) |
| `round:next` | `{}` (host only) |
| `game:again` | `{}` (host only) |

Server → clients (room-scoped):
| event | payload |
|---|---|
| `lobby:update` | `{ players: [{id, name, isHost}], settings }` |
| `round:start` | `{ roundNumber, totalRounds, quote: { content }, choices: [{authorId, displayName}], endsAt }` — **note: no author id on the quote object; never leak the answer to the client before reveal** |
| `round:progress` | `{ answeredPlayerIds }` (so players see who's locked in, not what they picked) |
| `round:reveal` | `{ correctAuthorId, sentAt, guesses: [{playerId, authorId, correct, points}], scores }` |
| `game:over` | `{ finalScores: [{playerId, name, score}] }` |
| `error` | `{ message }` |

Timer authority is the **server**: it emits `endsAt` (epoch ms) and enforces the deadline itself; clients render the countdown from `endsAt` so clock drift doesn't matter.

### 3.5 State & robustness

- All game state in memory (a `Map<roomCode, Game>`); only `times_played` is persisted. A server restart drops active games — acceptable.
- `game.js` holds pure logic (create room, join, start, answer, tick, reveal) operating on plain objects, no sockets/DB imports → write unit tests for it (answer after deadline rejected, double-answer ignored, host-only guards, author-cap in quote draw, scoring math).
- Disconnects: keep the player's score for 60 s so a refresh can rejoin by name; host disconnect promotes the oldest remaining player.

---

## 4. Client (`public/`)

One page, four screens toggled by JS: **join → lobby → round → reveal/leaderboard**. Requirements:

- Big readable quote text (this is the whole game — make it the visual centerpiece).
- Answer buttons disable after picking; show a subtle "3/5 answered" indicator from `round:progress`.
- Countdown bar driven by `endsAt`.
- Reveal screen: correct author highlighted, each player's guess shown, running scoreboard, quote date ("March 2024").
- Mobile-friendly — people will play on phones. No framework needed; keep it one `app.js` with a tiny render-per-screen approach.

---

## 5. Privacy & deployment

- **The raw export and quotes.db never leave the host machine.** Express must only serve `public/`; add an explicit check that no route touches `data/`.
- Clients only ever receive: the quotes drawn for the current game, one at a time, plus display names. They never receive the corpus, scores, or the DB.
- Hosting for friends, pick one (document both in README):
  1. **Tailscale** (recommended): everyone installs it, joins Roman's tailnet, connects to `http://<machine-name>:3000`. Zero exposure to the public internet.
  2. **cloudflared quick tunnel**: `cloudflared tunnel --url http://localhost:3000` gives a temporary public URL for game night. If used, the room code is the only gate — fine for a quotes game, but say so in the README.
- If Roman later puts it on his own web server instead: run ingest **locally**, copy only `quotes.db` (not `export.json`) to the server, and put the site behind a shared password (single `GAME_PASSWORD` env var checked at room join).

---

## 6. Implementation order

1. `ingest.js` + schema — verify against the real export, eyeball the top-10 preview.
2. `game.js` pure logic + unit tests.
3. `server.js` sockets wiring.
4. Client screens.
5. Polish: rejoin, host migration, auto-advance.

Definition of done for v1: two browser tabs on localhost can create/join a room, play 15 rounds from a real export with no repeated quotes, and see a final leaderboard.

---

# V2 — People config, fair draws, better curation, iMessage source

Four changes based on real play-testing. Implement in the order listed in §11.

## 7. People config — who's in the game, across both sources

Stop deriving the roster from message counts. A person is now the unit of identity, defined in `data/people.json` (gitignored):

```jsonc
{
  "people": [
    {
      "name": "Roman",                    // display name shown in the game
      "include": true,
      "discordIds": ["296394839820599298"],
      "imessageHandles": ["+15551234567"] // phone/email handles; "me" = the backup owner (isFromMe rows)
    }
  ]
}
```

- `node ingest/ingest.js --init-config <exports...>`: scans exports and writes a **skeleton** `people.json` — one entry per discovered Discord author with their id, display name, and surviving-message count, all `include: true`. Never overwrites an existing file (print a diff-style summary of newly discovered ids instead, and add them with `include: false`).
- The user edits the file by hand: flips `include: false` for the old dead account, merges duplicate accounts into one person, fills in `imessageHandles` later.
- Ingest drops all messages from non-included / unknown authors **before** scoring. No scrubbing of the raw export — it stays untouched; exclusion happens in the pipeline. The old ≥20-message auto-threshold is **removed** (superseded by explicit config; keep a warning when an included person has < 20 surviving quotes).
- DB schema: rename `authors` → `people (id INTEGER PK, name TEXT)`; `quotes.person_id` references it; add `quotes.source TEXT` (`'discord' | 'imessage'`). Ingest resolves every message's author/handle to a person via this config. The game's answer choices are included people.

## 8. Equal representation in quote draws

Problem: chatty friends dominate; quiet friends barely appear, and players can meta-game "when in doubt, guess the loud one."

Replace the per-author cap in `drawQuotes` with a **stratified draw**:

1. Let P = included people who have ≥ 1 candidate quote in the selected pool. Allocate `floor(N / P)` slots per person; distribute the remainder one-each to people chosen at random.
2. Fill each person's slots from *their own* quotes using the existing score × play-decay × jitter weighting.
3. If someone has too few quotes to fill their slots, redistribute the shortfall across the others (round-robin by weight).
4. Shuffle the final play order. No-repeat-within-game still holds by construction.

Unit-test: 3 people with 100/10/3 candidate quotes, N=15 → allocation is 5/5/3 with the shortfall redistributed (6/6/3), never 12/2/1.

## 9. Better humor curation (the quotes suck out of context)

The single "rate 0–10" prompt over-scores mundane conversation. Replace with a **two-stage LLM pass**, both stages cached in `llm_cache` keyed by `(message_id, model, prompt_version)` — bump `prompt_version` whenever a prompt string changes so stale ratings re-run:

- **Stage A — standalone gate (cheap, run on top ~2000 by heuristic pre-score):** ask: *"You see this chat message with NO other context. Does it make complete sense on its own — no missing references to earlier conversation ('that', 'he', 'it' with unclear referents), no logistics ('you coming?', 'what time'), not an answer to an unseen question? Reply YES or NO only."* Drop NOs (score 0, cached).
- **Stage B — funniness rating (run on Stage-A survivors):** describe the game in the prompt: *"We show this message to friends who must guess which group member said it. Rate 0–10 how funny/entertaining it is as a standalone quote. Favor: one-liners, unhinged outbursts, absurd declarations, strong opinions stated with conviction. Score 0–2: mundane conversation, questions, plans, generic reactions. Reply with only the number."* Include 3–4 few-shot examples **invented by you, generic** (never taken from the user's chat) showing a 9 (absurd outburst), a 6, and two 1s (logistics, context-dependent fragment).
- Blend shifts to LLM-dominant: `humor_score = 0.15 * heuristic_percentile + 0.85 * llm * 10`. Stage-A failures get `humor_score = min(heuristic_percentile, 20)` so they can still appear in the `interesting`/`mixed` pools but never lead `funny`.
- Add `--preview 30` flag: after scoring, print the top 30 by humor_score to the terminal for the user to eyeball (user reviews it themselves — the implementing agent should not read this output beyond confirming the command exited 0).
- If quality is still poor after this, the lever is the model, not more prompt surgery: try `qwen2.5:7b-instruct` or `llama3.1:8b` via the existing `--model` flag (one `ollama pull` away). Keep `llama3:latest` the working default.

## 10. iMessage group chat as a second quote source

**Source located (2026-07-15):** iPhone backup at `C:\Users\Roman\Apple\MobileSync\Backup\00008150-001845C60285401C\`, containing the Messages database at hashed path `3d\3d0d7e5fb2ce288813306e4d4636395e047a3d28` (this is `sms.db`, ~100 MB, backup dated 2026-05-05).

New adapter `ingest/imessage.js`, sharing the filter/score/LLM pipeline with Discord (refactor shared logic into `ingest/common.js`; `ingest/ingest.js` becomes the Discord adapter + CLI entry that can take both sources).

Steps:

1. **Copy, never touch the backup:** copy the hashed file to `data/sms.db` (read-only source). If it fails to open as SQLite, the backup is **encrypted** — stop and tell the user they need an unencrypted backup (uncheck "Encrypt local backup" in Apple Devices/iTunes and re-sync) or a licensed extractor. Do not attempt decryption.
2. **`--list-chats`:** print group chats only — `chat.ROWID`, display name if set, participant handles, message count. **Names/handles/counts only, never message text.** The user picks the right chat id and puts it in `people.json` → `"imessageChatId": <ROWID>` (top-level key).
3. **Extract:** for that chat id, join `chat_message_join` → `message` → `handle`. Map each row to the common internal format:
   - id: `imsg-<message.guid>`; author: `handle.id` (phone/email), or the person whose handles contain `"me"` when `message.is_from_me = 1`.
   - timestamp: `message.date` is Apple epoch (seconds — or **nanoseconds** on newer iOS — since 2001-01-01 UTC; detect by magnitude, > 1e12 means ns).
   - text: `message.text`, but on newer iOS the text often lives only in the `attributedBody` blob (typedstream). Implement the known minimal extraction (scan the blob for the NSString payload); skip rows where neither yields text, and **report the skip count** so the user knows if a large share was lost.
   - **Tapbacks are the reaction signal:** rows with `associated_message_type` 2000–2005 are reactions to another message, not quotes — exclude them as quotes, but count them toward the target message's score. `2003` = "Ha Ha" → weight like a laugh reaction (strong). Others → weight like a generic reaction.
4. **Shared pipeline:** same filters (URL/length/self-identifying — name filter now uses people.json names + all known handles), same reply-burst heuristic, same two-stage LLM pass. Insert with `source = 'imessage'`.
5. Unmatched handles found in the chat: print them (handle string + count only) and skip their messages until the user assigns them to a person in `people.json`.

Privacy rules unchanged and extended: `data/` stays gitignored and unservable; sms.db and all message content never leave the machine; scripts print only names, handles, counts, and the user-facing `--preview` list.

## 11. V2 implementation order

1. §7 people config + `--init-config` + DB schema migration (drop/recreate quotes.db is fine — it's derived data; `llm_cache` must survive, it's keyed by message id).
2. §8 stratified draw + unit tests (this is pure `game.js`/draw logic — shippable immediately).
3. §9 two-stage LLM pass + `--preview`; re-run ingest; user eyeballs top-30.
4. §10 iMessage adapter (`--list-chats` first, get the chat id from the user, then extraction), re-run full ingest with both sources.

Definition of done for v2: `people.json` controls exactly who appears; a 15-round game gives every included person a near-equal number of quotes; the `funny` pool's top quotes read as standalone one-liners; quotes from both Discord and iMessage appear in one game under each person's single display name.
