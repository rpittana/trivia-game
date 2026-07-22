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

### 9.1 Curation quality fixes (v3) — the rater is too generous

**Observed failure (2026-07-15, user-reported):** the top-50 is full of mundane, context-dependent gaming chatter rated 93+. DB stats confirm score saturation: 208 quotes tied at 96, hundreds more at 93–95 — the model is handing out 9/10s so freely that the top of the leaderboard is a coin flip among garbage. llama3:latest is a weak, over-generous judge; prompt surgery alone won't fix a rater that thinks everything is a 10. Apply ALL of the following:

1. **Switch the rating model.** `ollama pull qwen2.5:7b-instruct` (~4.7 GB) and make it the new default for ingest runs (`--model=qwen2.5:7b-instruct`). Same size class as llama3 so speed is comparable, but a far better instruction-follower and a much more discriminating judge. Keep `--model` overridable; if quality is still poor, the next step up is `qwen2.5:14b-instruct` (slower, needs ~10 GB RAM).
2. **Deterministic ratings.** Pass Ollama `options: { temperature: 0, seed: 7 }` on every generate call so re-runs are reproducible and ratings aren't inflated by sampling luck.
3. **Recalibrate the Stage B rubric.** Replace the current prompt's soft guidance with hard distribution anchors, along these lines: *"Most chat messages are NOT funny: the median message scores 1. Reserve 8–10 for messages so absurd or unhinged they'd be funny printed on a T-shirt. A plain statement, question, correction, or opinion about a game/show/plan is 0–2 even if it's emphatic or in all caps. Fewer than 1 in 20 messages deserves more than a 7."* Keep few-shot anchors but make the low anchors match the observed failure mode — invent generic analogues (e.g. "you don't have Minecraft" → 1, "how does this company even make money" → 1, "the shop is not the same thing" → 0). **Never embed the user's real messages in prompts or code — invent equivalents.**
4. **Tighten Stage A too** (cheap while we're here): add *"If the message is a reaction to or continuation of an unseen discussion — a correction, disagreement, or answer — reply NO."*
5. **Bump `PROMPT_VERSION` to "v3" AND clear the cache completely** (`DELETE FROM llm_cache`). The model change alone would miss the cache anyway, but a full clear also erases the historical imbalance where Discord got ~2,000 evaluations across earlier buggy runs vs iMessage's 1,000 — this run is the clean, fair baseline for both sources.
6. **Re-run and verify saturation is gone:** after ingest, check `SELECT humor_score, COUNT(*) FROM quotes GROUP BY humor_score ORDER BY humor_score DESC LIMIT 10` — the top bucket should hold a handful of quotes, not 200. Then `--preview=50` for the user to judge content quality themselves (implementer reads counts only, never quote text).

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

---

# V3 — Presentation, feedback, and stats

Seven features that make the game more fun and self-improving. **Read the existing socket contract in §3.4 and the current `server/server.js`, `server/game.js`, `server/db.js`, `public/app.js`, and `public/index.html` before starting** — every payload below extends the ones already there; do not invent parallel ones. Everything here is local-only (no new privacy surface): all data stays in `data/quotes.db` on the host, clients still only ever receive the current round's quote + display names/colors + aggregate stats, never the corpus.

Implement in the order of §19. §12 is foundational — do it first, the rest depend on it.

## 12. Persistence that survives re-ingest (foundational)

Downvotes (§16) and guessability stats (§17) must NOT be wiped every time the user re-runs ingest. The pattern already exists: `llm_cache` is created `IF NOT EXISTS` and never dropped by `buildDatabase` in `ingest/common.js`, while `quotes` and `people` are `DROP`/recreated. Add two more never-dropped tables the same way, keyed by ids that are **stable across re-ingest**:

```sql
-- keyed by message id (survives re-ingest: same Discord/iMessage message keeps its id)
CREATE TABLE IF NOT EXISTS quote_feedback (
  message_id TEXT PRIMARY KEY,
  downvotes INTEGER NOT NULL DEFAULT 0
);
-- keyed by person id from people.json (stable as long as the user doesn't renumber people)
CREATE TABLE IF NOT EXISTS person_stats (
  person_id INTEGER PRIMARY KEY,
  quotes_shown  INTEGER NOT NULL DEFAULT 0,
  total_guesses INTEGER NOT NULL DEFAULT 0,
  correct_guesses INTEGER NOT NULL DEFAULT 0
);
```

In `buildDatabase`, add both to the `CREATE TABLE IF NOT EXISTS` block, above the `DROP TABLE` lines. Never drop them. Everything in §16/§17 writes here.

## 13. Per-person colors

Give every person a stable color used everywhere their identity appears.

- **Source of truth:** optional `"color": "#rrggbb"` per person in `data/people.json`. If absent, assign deterministically from a fixed palette by index (define an 8-color colorblind-friendly palette in `common.js`; `color = palette[personIndex % palette.length]`). `--init-config` should write a default `color` into each new skeleton entry so the user can tweak it.
- **Plumb it through:** `db.getPeople()` returns `color`; `game.buildChoices` carries `color` onto each choice; the `round:start` `choices[]` entries gain `color`; add `color` to the reveal path so the client can color "It was ___".
- **Client use (`app.js` + `style.css`):** choice buttons tinted with the person's color (colored left border or background at low opacity; keep text readable); the "It was X!" reveal heading in that color; the person's color as a dot next to their name wherever names are listed. Note the scoreboard lists *players* (people in the room), not *people* (quote authors) — colors apply to the quote-author identity (choices + reveal), not necessarily player rows.

## 14. Quote stays visible on the reveal screen

Right now `screen-reveal` shows "It was X!" but drops the quote itself. Keep the quote on screen through the reveal so players can react to it.

- Client-only. On `round:start`, save the quote text to `state.currentQuoteContent`. Add a `#reveal-quote` element to `screen-reveal` in `index.html`; in the `round:reveal` handler, render `state.currentQuoteContent` into it (styled like `#round-quote`, the visual centerpiece). No server or payload change needed.

## 15. Year toggle (show-year hint)

A per-game host toggle, off by default: when on, the round display shows the year the quote was sent (just the year, e.g. "2021") alongside the quote text, as a timing hint for guessers. Not a filter — the draw pool is unaffected either way.

- **Server:** extend `game:start` settings with `showYear: boolean` (default `false`), stored on `game.settings` in `game.startGame` alongside `rounds`/`roundSeconds`/`pool`. In `server.js`'s `emitRoundStart`, when `g.settings.showYear` is true, include the year in the `round:start` payload: `quote: { content, year: new Date(round.quote.sentAt).getFullYear() }`; when false, omit `year` entirely (`quote: { content }` as today) — this must stay server-controlled so a client can't see the year by inspecting network traffic when the host has it off. The full `sentAt` continues to be revealed only at `round:reveal`, unchanged.
- **Client:** a checkbox in the lobby host controls, "Show year during round (hint)"; included in the `game:start` emit. In the `round:start` handler, if `quote.year` is present, render it as a small badge near `#round-quote` (e.g. `#round-year`); hide/clear it when absent.

## 16. Downvoting bad quotes

Players flag quotes that don't work; enough downvotes removes a quote from future draws. Self-cleaning corpus.

- **New socket event** `quote:downvote` (client→server), payload `{}` — it always refers to the room's current round quote (server looks up `g.currentRound.quote.id`; ignore if not in reveal/round state). Any player may vote once per quote per round; track voters in the round object to prevent double-count.
- **Server/db:** `db.downvoteQuote(messageId)` → `INSERT INTO quote_feedback(message_id, downvotes) VALUES(?,1) ON CONFLICT(message_id) DO UPDATE SET downvotes = downvotes + 1`. Broadcast `quote:downvoted` `{ count }` so the client can show the tally live.
- **Draw exclusion:** `db.getCandidateQuotes()` LEFT JOINs `quote_feedback` and returns `downvotes`; in `game.drawQuotes`, drop any quote with `downvotes >= 3` from the candidate set before allocating (a module-level `DOWNVOTE_HIDE_THRESHOLD = 3`). Add a unit test: a quote at the threshold is never drawn.
- **Client:** a small "👎 bad quote" button on the reveal screen; disables after the local player clicks; shows the running count from `quote:downvoted`.

## 17. Guessability / predictability (global stat)

Across all games ever played on this install, track how often each person's quotes get guessed correctly — the higher, the more predictable. A persistent global leaderboard.

- **Record on every reveal (`server.js` `doReveal` / after `game.revealRound`):** for the round's quote author `personId`, call `db.recordReveal(personId, totalGuesses, correctGuesses)` where `totalGuesses` = number of players who answered and `correctGuesses` = how many were right (both derivable from the `guesses[]` the reveal already computes). Updates `person_stats`: `quotes_shown += 1`, `total_guesses += totalGuesses`, `correct_guesses += correctGuesses`.
- **db.getGuessability()** → `[{ personId, name, pct, sample }]` where `pct = correct_guesses / total_guesses * 100`, `sample = total_guesses`. Exclude people with `sample < 10` (label them "not enough data" client-side rather than ranking noise).
- **Expose:** include `guessability` in the `game:over` payload (sorted most-predictable first). Client renders a "Predictability Board" on the game-over screen: e.g. "🔮 Most predictable: Talon — 74% guessed right" down to "🎭 Most mysterious: Bryce — 31%". This is cumulative across games, so it grows more meaningful over time; make that clear in the UI ("all-time, N guesses").

## 18. Sound effects

Client-only, **zero asset files** — synthesize with the Web Audio API in a new `public/sound.js` (no external URLs, keeps the offline/no-CDN rule). Provide short synthesized cues:
- new round starts, answer locked in (soft click), you-got-it-right (rising chime) vs wrong (low buzz) on reveal, countdown tick for the final 5 seconds, game-over fanfare.
- A mute toggle in the top corner, state persisted in `localStorage`. Respect browser autoplay policy: create/resume the `AudioContext` on the first user gesture (the create/join click).

### 18a. `game:meta` event (supporting §13)

Add a server→client `game:meta` emitted right after a socket joins a room (in `room:create`/`room:join` handlers), payload `{ people: [{id, name, color}] }` (from `db.getPeople()`). The client caches it for color lookups (§13). Keeps colors out of the per-round payloads where they don't belong.

## 19. More visual effects

Client + CSS only, building on the existing screen system and `style.css` variables:
- Confetti burst on a correct answer and on the game-over winner — self-contained canvas or DOM particles, no libraries.
- Animated screen transitions (fade/slide between join→lobby→round→reveal).
- Timer bar turns amber then red and pulses in the final 5 seconds (pairs with the §18 tick).
- Correct/wrong full-card flash on reveal; count-up animation on score changes; a crown/glow on the winner at game-over.
- Keep it tasteful and performant on phones; use `prefers-reduced-motion` to tone down for anyone who sets it.

## 20. V3 socket contract additions & implementation order

New/changed events (extend §3.4, don't replace):

| direction | event | payload |
|---|---|---|
| S→C | `game:meta` | `{ people: [{id, name, color}] }` |
| C→S | `game:start` | now also `{ showYear: boolean }` |
| S→C | `round:start` | `choices[]` entries now also carry `color`; `quote` gains `year` (only present when `showYear` is on) |
| C→S | `quote:downvote` | `{}` (refers to current round quote) |
| S→C | `quote:downvoted` | `{ count }` |
| S→C | `game:over` | now also `{ guessability: [{personId, name, pct, sample}] }` |

Order:
1. §12 persistence tables (in `ingest/common.js` `buildDatabase`) + the `db.js` accessors the rest need. Re-run ingest once to create the tables (existing scores/cache untouched).
2. §13 colors + §18a `game:meta` (they share the plumbing).
3. §14 quote-on-reveal (pure client, quick win).
4. §16 downvoting + unit test for the draw threshold.
5. §17 guessability recording + game-over board.
6. §15 year filter.
7. §18 sound + §19 visual effects last (pure presentation, iterate with the user).

Definition of done for v3: each person shows in a consistent color; the quote stays visible on reveal; players can downvote a quote and after 3 downvotes it stops appearing; the game-over screen shows an all-time predictability board that persists across re-ingest; the host can restrict a game to chosen years; sounds and effects fire on the key moments with a working mute and `prefers-reduced-motion` respected.
