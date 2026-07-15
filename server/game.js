// Pure game-state logic. No sockets, no DB, no timers — operates on plain
// objects so it can be unit tested directly. server.js is the only caller.
"use strict";

const REJOIN_GRACE_MS = 60 * 1000;
const MAX_CHOICES = 8;

function scoreFor(quote, pool) {
  if (pool === "funny") return quote.humorScore;
  if (pool === "interesting") return quote.interestScore;
  return (quote.humorScore + quote.interestScore) / 2;
}

/**
 * Selects `count` quotes from `candidates` (plain objects with
 * {id, authorId, content, sentAt, humorScore, interestScore, timesPlayed}),
 * preferring high-scoring, less-recently-played quotes, with jitter so
 * repeat games differ, and a per-author cap so one chatty friend can't
 * dominate a single game's draw.
 */
function drawQuotes(candidates, count, pool, rng = Math.random) {
  if (candidates.length === 0) return [];
  const distinctAuthors = new Set(candidates.map((c) => c.authorId)).size;
  const cap = Math.ceil(count / Math.max(1, distinctAuthors)) + 1;

  const weighted = candidates.map((c) => ({
    quote: c,
    weight: scoreFor(c, pool) * (1 / (1 + c.timesPlayed)) * (0.7 + 0.3 * rng()),
  }));
  weighted.sort((a, b) => b.weight - a.weight);

  const authorCounts = new Map();
  const selected = [];
  const selectedIds = new Set();

  for (const { quote } of weighted) {
    if (selected.length >= count) break;
    const n = authorCounts.get(quote.authorId) || 0;
    if (n < cap) {
      selected.push(quote);
      selectedIds.add(quote.id);
      authorCounts.set(quote.authorId, n + 1);
    }
  }
  // Cap made it impossible to fill the draw (e.g. very few distinct authors) — top up ignoring the cap.
  if (selected.length < count) {
    for (const { quote } of weighted) {
      if (selected.length >= count) break;
      if (!selectedIds.has(quote.id)) {
        selected.push(quote);
        selectedIds.add(quote.id);
      }
    }
  }

  // Shuffle play order (the weighting above sorted by score, not play sequence).
  for (let i = selected.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  return selected.slice(0, count);
}

/** Builds the answer-choice list for a round: the true author plus up to 7 random others, shuffled. */
function buildChoices(quote, allAuthors, rng = Math.random) {
  const correct = allAuthors.find((a) => a.id === quote.authorId);
  const others = allAuthors.filter((a) => a.id !== quote.authorId);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const choices = [correct, ...others.slice(0, MAX_CHOICES - 1)];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return choices;
}

function createGame(roomCode, hostId, hostName, now = Date.now()) {
  return {
    roomCode,
    hostId,
    players: new Map([[hostId, { id: hostId, name: hostName, score: 0, connected: true, disconnectedAt: null }]]),
    status: "lobby",
    settings: null,
    quotes: [],
    authors: [],
    roundIndex: -1,
    currentRound: null,
    createdAt: now,
  };
}

function addPlayer(game, playerId, name) {
  if (game.status !== "lobby") {
    throw new GameError("Game already in progress — can't join mid-round.");
  }
  if (game.players.has(playerId)) return;
  game.players.set(playerId, { id: playerId, name, score: 0, connected: true, disconnectedAt: null });
}

/** Attempts to reattach a fresh connection to a recently-disconnected player with the same name. */
function rejoinByName(game, name, now = Date.now()) {
  for (const p of game.players.values()) {
    if (!p.connected && p.name === name && now - p.disconnectedAt <= REJOIN_GRACE_MS) {
      p.connected = true;
      p.disconnectedAt = null;
      return p.id;
    }
  }
  return null;
}

function markDisconnected(game, playerId, now = Date.now()) {
  const p = game.players.get(playerId);
  if (!p) return;
  p.connected = false;
  p.disconnectedAt = now;
  if (game.hostId === playerId) promoteHost(game);
}

function promoteHost(game) {
  const next = [...game.players.values()].find((p) => p.connected && p.id !== game.hostId);
  if (next) game.hostId = next.id;
}

/** Drops players who've been disconnected past the grace period. Call periodically. */
function removeStalePlayers(game, now = Date.now()) {
  for (const [id, p] of game.players) {
    if (!p.connected && now - p.disconnectedAt > REJOIN_GRACE_MS) {
      game.players.delete(id);
    }
  }
}

class GameError extends Error {}

function requireHost(game, requesterId) {
  if (requesterId !== game.hostId) throw new GameError("Only the host can do that.");
}

function startGame(game, hostId, settings, candidateQuotes, authors, rng = Math.random, now = Date.now()) {
  requireHost(game, hostId);
  if (game.status !== "lobby") throw new GameError("Game already started.");
  const rounds = settings.rounds || 15;
  const roundSeconds = settings.roundSeconds || 20;
  const pool = settings.pool || "mixed";

  const quotes = drawQuotes(candidateQuotes, rounds, pool, rng);
  if (quotes.length === 0) throw new GameError("No quotes available to play.");

  game.settings = { rounds: quotes.length, roundSeconds, pool };
  game.quotes = quotes;
  game.authors = authors;
  game.status = "in-progress";
  game.roundIndex = -1;
  for (const p of game.players.values()) p.score = 0;

  return startNextRound(game, rng, now);
}

function startNextRound(game, rng = Math.random, now = Date.now()) {
  game.roundIndex++;
  if (game.roundIndex >= game.quotes.length) {
    game.status = "game-over";
    game.currentRound = null;
    return null;
  }
  const quote = game.quotes[game.roundIndex];
  const choices = buildChoices(quote, game.authors, rng);
  game.currentRound = {
    quote,
    choices,
    endsAt: now + game.settings.roundSeconds * 1000,
    answers: new Map(), // playerId -> { authorId, answeredAt }
  };
  game.status = "in-progress";
  return game.currentRound;
}

function submitAnswer(game, playerId, authorId, now = Date.now()) {
  if (game.status !== "in-progress" || !game.currentRound) {
    throw new GameError("No round is currently active.");
  }
  if (!game.players.has(playerId)) throw new GameError("Unknown player.");
  if (now > game.currentRound.endsAt) return false; // too late, silently ignored
  if (game.currentRound.answers.has(playerId)) return false; // already answered, first answer wins
  game.currentRound.answers.set(playerId, { authorId, answeredAt: now });
  return true;
}

function allAnswered(game) {
  if (!game.currentRound) return false;
  const activePlayers = [...game.players.values()].filter((p) => p.connected);
  return activePlayers.every((p) => game.currentRound.answers.has(p.id));
}

function isRoundExpired(game, now = Date.now()) {
  return !!game.currentRound && now >= game.currentRound.endsAt;
}

function revealRound(game, now = Date.now()) {
  if (!game.currentRound) throw new GameError("No round is currently active.");
  const round = game.currentRound;
  const correctAuthorId = round.quote.authorId;
  const roundSeconds = game.settings.roundSeconds;

  const guesses = [];
  for (const player of game.players.values()) {
    const answer = round.answers.get(player.id);
    if (!answer) {
      guesses.push({ playerId: player.id, authorId: null, correct: false, points: 0 });
      continue;
    }
    const correct = answer.authorId === correctAuthorId;
    let points = 0;
    if (correct) {
      const elapsedMs = Math.max(0, Math.min(roundSeconds * 1000, answer.answeredAt - (round.endsAt - roundSeconds * 1000)));
      const timeRemaining = roundSeconds - elapsedMs / 1000;
      points = 100 + Math.round(50 * (timeRemaining / roundSeconds));
      player.score += points;
    }
    guesses.push({ playerId: player.id, authorId: answer.authorId, correct, points });
  }

  game.status = "reveal";
  return {
    correctAuthorId,
    sentAt: round.quote.sentAt,
    guesses,
    scores: [...game.players.values()].map((p) => ({ playerId: p.id, name: p.name, score: p.score })),
  };
}

function nextRound(game, requesterId, rng = Math.random, now = Date.now()) {
  requireHost(game, requesterId);
  if (game.status !== "reveal") throw new GameError("Round hasn't been revealed yet.");
  return startNextRound(game, rng, now);
}

function isGameOver(game) {
  return game.status === "game-over";
}

function finalScores(game) {
  return [...game.players.values()]
    .map((p) => ({ playerId: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function playAgain(game, requesterId, candidateQuotes, rng = Math.random, now = Date.now()) {
  requireHost(game, requesterId);
  if (game.status !== "game-over") throw new GameError("Game isn't over yet.");
  game.status = "lobby";
  const settings = game.settings;
  return { readyToStart: () => startGame(game, requesterId, settings, candidateQuotes, game.authors, rng, now) };
}

module.exports = {
  GameError,
  createGame,
  addPlayer,
  rejoinByName,
  markDisconnected,
  promoteHost,
  removeStalePlayers,
  startGame,
  startNextRound,
  submitAnswer,
  allAnswered,
  isRoundExpired,
  revealRound,
  nextRound,
  isGameOver,
  finalScores,
  playAgain,
  drawQuotes,
  buildChoices,
  REJOIN_GRACE_MS,
};
