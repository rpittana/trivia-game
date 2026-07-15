# Who Said It? — Discord Quote Trivia

Private, self-hosted "guess who sent this message" game built from your Discord export. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## One-time setup

```
npm install
```

Put your DiscordChatExporter **JSON** export in `data/` (any filename), then run:

```
node ingest/ingest.js "data/your-export.json"
```

This filters and scores your messages and writes `data/quotes.db`. It uses your local Ollama (`llama3:latest` on this machine) to help rank funniness — nothing leaves your computer. Re-run this any time you have a fresh export; it's safe to run repeatedly (LLM ratings are cached).

Useful flags:
- `--model=llama3:latest` — which Ollama model to use (defaults to `llama3.1:8b`, which isn't installed on this machine — always pass `--model=llama3:latest` here, or run `ollama pull llama3.1:8b` first)
- `--no-ollama` — skip LLM ranking, use engagement-based heuristic scores only
- `--candidates=800` — how many top messages get sent to the LLM for rating

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

Runs the pure game-logic unit tests (`server/game.test.js`) — scoring math, host-only guards, answer timing, the author-cap in quote selection, etc.
