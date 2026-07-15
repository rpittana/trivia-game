# Who Said It? — Discord Quote Trivia

Private, self-hosted "guess who sent this message" game built from your Discord export. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## One-time setup

```
npm install
```

Put your DiscordChatExporter **JSON** export in `data/` (any filename). First build the roster:

```
node ingest/ingest.js --init-config "data/your-export.json"
```

This writes `data/people.json` — edit it to control who's in the game (`include: true/false`), merge duplicate accounts, and (optionally) wire up iMessage handles per person (see `--list-chats` / `--show-chat=<id>` below). Then run the full pipeline:

```
node ingest/ingest.js "data/your-export.json"
```

This filters and scores your messages and writes `data/quotes.db`. It uses your local Ollama (`qwen2.5:7b-instruct` on this machine — `ollama pull qwen2.5:7b-instruct` once) to curate funniness in two stages (a standalone-sense gate, then a harsh 0–10 funniness rating) — nothing leaves your computer. Re-run this any time you have a fresh export or edit `people.json`; it's safe to run repeatedly (LLM ratings are cached by model + prompt version).

Useful flags:
- `--model=qwen2.5:7b-instruct` — which Ollama model to use for curation
- `--no-ollama` — skip LLM curation, use engagement-based heuristic scores only
- `--candidates=2000` — how many top messages (split evenly per source) get sent through LLM curation
- `--preview=30` — how many top quotes to print for you to eyeball after a run
- `--list-chats` — list your iMessage group chats (names/handles/counts only) to find the right `imessageChatId`
- `--show-chat=<id>` — show one chat's participants, resolved against your Contacts where possible

## Running the game

```
npm start
```

Then open `http://localhost:3000`. One person creates a room and shares the 4-letter code; everyone else joins with it.

## Playing with friends who aren't on your machine

Recommended: install [Tailscale](https://tailscale.com) on your machine and your friends'. Once everyone's on the same tailnet, they browse to `http://<your-machine-name>:3000`. Nothing is exposed to the public internet.

Alternative for a one-off game night: `cloudflared tunnel --url http://localhost:3000` gives a temporary public URL. The room code is the only gate in that case, so don't leave it running.

## Tests

```
npm test
```

Runs the pure game-logic unit tests (`server/game.test.js`) — scoring math, host-only guards, answer timing, the per-person stratified quote draw, etc.
