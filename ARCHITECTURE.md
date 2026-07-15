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
