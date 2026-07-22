// Pure game-state logic. No sockets, no DB, no timers — operates on plain
// objects so it can be unit tested directly. server.js is the only caller.
"use strict";

const REJOIN_GRACE_MS = 60 * 1000;
const MAX_CHOICES = 8;
const DOWNVOTE_HIDE_THRESHOLD = 3;

function scoreFor(quote, pool) {
  if (pool === "funny") return quote.humorScore;
  if (pool === "interesting") return quote.interestScore;
  return (quote.humorScore + quote.interestScore) / 2;
}

/**
 * Selects `count` quotes from `candidates` (plain objects with
 * {id, personId, content, sentAt, humorScore, interestScore, timesPlayed}).
 * Allocates roughly equal slots to every person who has candidate quotes
 * (floor(count/P) each, remainder spread randomly), fills each person's
 * slots from their own best-scoring quotes, and redistributes any shortfall
 * (someone with too few quotes) round-robin across people who have more —
 * so one chatty friend never dominates the draw. Play order is shuffled
 * at the end; no-repeat-within-game holds by construction.
 */
function drawQuotes(candidates, count, pool, rng = Math.random) {
  candidates = candidates.filter((c) => (c.downvotes || 0) < DOWNVOTE_HIDE_THRESHOLD);
  if (candidates.length === 0) return [];

  const byPerson = new Map();
  for (const c of candidates) {
    if (!byPerson.has(c.personId)) byPerson.set(c.personId, []);
    byPerson.get(c.personId).push(c);
  }
  const personIds = [...byPerson.keys()];
  const target = Math.min(count, candidates.length);

  const base = Math.floor(target / personIds.length);
  const remainder = target - base * personIds.length;

  const shuffledPeople = [...personIds];
  for (let i = shuffledPeople.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledPeople[i], shuffledPeople[j]] = [shuffledPeople[j], shuffledPeople[i]];
  }
  const slots = new Map(personIds.map((id) => [id, base]));
  for (let i = 0; i < remainder; i++) slots.set(shuffledPeople[i], slots.get(shuffledPeople[i]) + 1);

  const weightedByPerson = new Map();
  for (const [id, list] of byPerson) {
    const weighted = list.map((c) => ({
      quote: c,
      weight: scoreFor(c, pool) * (1 / (1 + c.timesPlayed)) * (0.7 + 0.3 * rng()),
    }));
    weighted.sort((a, b) => b.weight - a.weight);
    weightedByPerson.set(id, weighted);
  }

  const selected = [];
  const consumed = new Map(personIds.map((id) => [id, 0]));
  let shortfall = 0;

  for (const id of personIds) {
    const want = slots.get(id);
    const available = weightedByPerson.get(id);
    const take = Math.min(want, available.length);
    for (let i = 0; i < take; i++) selected.push(available[i].quote);
    consumed.set(id, take);
    shortfall += want - take;
  }

  let stillNeeded = shortfall;
  let progress = true;
  while (stillNeeded > 0 && progress) {
    progress = false;
    for (const id of shuffledPeople) {
      if (stillNeeded <= 0) break;
      const idx = consumed.get(id);
      const available = weightedByPerson.get(id);
      if (idx < available.length) {
        selected.push(available[idx].quote);
        consumed.set(id, idx + 1);
        stillNeeded--;
        progress = true;
      }
    }
  }

  for (let i = selected.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  return selected.slice(0, target);
}

/** Builds the answer-choice list for a round: the true person plus up to 7 random others, shuffled. */
function buildChoices(quote, allPeople, rng = Math.random) {
  const correct = allPeople.find((p) => p.id === quote.personId);
  const others = allPeople.filter((p) => p.id !== quote.personId);
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
    people: [],
    roundIndex: -1,
    currentRound: null,
    perGameStats: new Map(),
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

function startGame(game, hostId, settings, candidateQuotes, people, rng = Math.random, now = Date.now()) {
  requireHost(game, hostId);
  if (game.status !== "lobby") throw new GameError("Game already started.");
  const rounds = settings.rounds || 15;
  const roundSeconds = settings.roundSeconds || 20;
  const pool = settings.pool || "mixed";
  const showYear = !!settings.showYear;

  const quotes = drawQuotes(candidateQuotes, rounds, pool, rng);
  if (quotes.length === 0) throw new GameError("No quotes available to play.");

  game.settings = { rounds: quotes.length, roundSeconds, pool, showYear };
  game.quotes = quotes;
  game.people = people;
  game.status = "in-progress";
  game.roundIndex = -1;
  game.perGameStats = new Map(); // personId -> { shown, guesses, correct }, reset every game
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
  const choices = buildChoices(quote, game.people, rng);
  game.currentRound = {
    quote,
    choices,
    endsAt: now + game.settings.roundSeconds * 1000,
    answers: new Map(), // playerId -> { personId, answeredAt }
    downvoters: new Set(), // playerIds who've downvoted this round's quote
    upvoters: new Set(), // playerIds who've upvoted this round's quote
  };
  game.status = "in-progress";
  return game.currentRound;
}

/**
 * Records a vote from `playerId` for the current round's quote. A player gets one
 * vote per round total — whichever direction they click first locks it; clicking
 * the other direction afterward is ignored (returns false), same as clicking their
 * own direction twice.
 */
function downvoteCurrentQuote(game, playerId) {
  if (!game.currentRound) throw new GameError("No round is currently active.");
  if (!game.players.has(playerId)) throw new GameError("Unknown player.");
  if (game.currentRound.downvoters.has(playerId) || game.currentRound.upvoters.has(playerId)) return false;
  game.currentRound.downvoters.add(playerId);
  return true;
}

function upvoteCurrentQuote(game, playerId) {
  if (!game.currentRound) throw new GameError("No round is currently active.");
  if (!game.players.has(playerId)) throw new GameError("Unknown player.");
  if (game.currentRound.upvoters.has(playerId) || game.currentRound.downvoters.has(playerId)) return false;
  game.currentRound.upvoters.add(playerId);
  return true;
}

function submitAnswer(game, playerId, personId, now = Date.now()) {
  if (game.status !== "in-progress" || !game.currentRound) {
    throw new GameError("No round is currently active.");
  }
  if (!game.players.has(playerId)) throw new GameError("Unknown player.");
  if (now > game.currentRound.endsAt) return false; // too late, silently ignored
  if (game.currentRound.answers.has(playerId)) return false; // already answered, first answer wins
  game.currentRound.answers.set(playerId, { personId, answeredAt: now });
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
  const correctPersonId = round.quote.personId;
  const roundSeconds = game.settings.roundSeconds;

  const guesses = [];
  for (const player of game.players.values()) {
    const answer = round.answers.get(player.id);
    if (!answer) {
      guesses.push({ playerId: player.id, personId: null, correct: false, points: 0 });
      continue;
    }
    const correct = answer.personId === correctPersonId;
    let points = 0;
    if (correct) {
      const elapsedMs = Math.max(0, Math.min(roundSeconds * 1000, answer.answeredAt - (round.endsAt - roundSeconds * 1000)));
      const timeRemaining = roundSeconds - elapsedMs / 1000;
      points = 100 + Math.round(50 * (timeRemaining / roundSeconds));
      player.score += points;
    }
    guesses.push({ playerId: player.id, personId: answer.personId, correct, points });
  }

  const totalGuesses = guesses.filter((g) => g.personId != null).length;
  const correctGuessCount = guesses.filter((g) => g.correct).length;
  const stat = game.perGameStats.get(correctPersonId) || { shown: 0, guesses: 0, correct: 0 };
  stat.shown += 1;
  stat.guesses += totalGuesses;
  stat.correct += correctGuessCount;
  game.perGameStats.set(correctPersonId, stat);

  game.status = "reveal";
  return {
    correctPersonId,
    sentAt: round.quote.sentAt,
    guesses,
    scores: [...game.players.values()].map((p) => ({ playerId: p.id, name: p.name, score: p.score })),
  };
}

/** Per-game predictability for every person whose quote got at least one guess this game, most-predictable first. */
function thisGamePredictability(game) {
  const result = [];
  for (const [personId, stat] of game.perGameStats || []) {
    if (stat.guesses === 0) continue; // no guesses recorded — no meaningful percentage to show
    const person = game.people.find((p) => p.id === personId);
    result.push({
      personId,
      name: person ? person.displayName : "?",
      pct: Math.round((stat.correct / stat.guesses) * 100),
      sample: stat.guesses,
    });
  }
  result.sort((a, b) => b.pct - a.pct);
  return result;
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

/**
 * Sends the room back to the lobby after a finished game. Players and their
 * connection state are untouched; scores reset the next time startGame runs.
 * `game.settings` is deliberately kept (not cleared) so the lobby can prefill
 * the host's controls with what was last used.
 */
function returnToLobby(game, requesterId) {
  requireHost(game, requesterId);
  if (game.status !== "game-over") throw new GameError("Game isn't over yet.");
  game.status = "lobby";
  game.roundIndex = -1;
  game.quotes = [];
  game.currentRound = null;
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
  returnToLobby,
  drawQuotes,
  buildChoices,
  downvoteCurrentQuote,
  upvoteCurrentQuote,
  thisGamePredictability,
  REJOIN_GRACE_MS,
  DOWNVOTE_HIDE_THRESHOLD,
};
