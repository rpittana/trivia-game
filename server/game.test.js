"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const game = require("./game");

function mkQuote(id, authorId, overrides = {}) {
  return {
    id,
    authorId,
    content: `quote ${id}`,
    sentAt: "2024-01-01T00:00:00Z",
    humorScore: 50,
    interestScore: 50,
    timesPlayed: 0,
    ...overrides,
  };
}

function mkAuthors(ids) {
  return ids.map((id) => ({ id, displayName: `author-${id}` }));
}

// deterministic PRNG for reproducible tests
function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test("drawQuotes respects the per-author cap", () => {
  const candidates = [];
  for (let i = 0; i < 20; i++) candidates.push(mkQuote(`a${i}`, "loud-friend"));
  for (let i = 0; i < 5; i++) candidates.push(mkQuote(`b${i}`, "quiet-friend-1"));
  for (let i = 0; i < 5; i++) candidates.push(mkQuote(`c${i}`, "quiet-friend-2"));

  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(42));
  const counts = new Map();
  for (const q of drawn) counts.set(q.authorId, (counts.get(q.authorId) || 0) + 1);

  // distinctAuthors=3, cap = ceil(15/3)+1 = 6
  assert.ok(counts.get("loud-friend") <= 6, `loud-friend appeared ${counts.get("loud-friend")} times`);
  assert.equal(drawn.length, 15);
});

test("drawQuotes returns no duplicate quote ids", () => {
  const candidates = [];
  for (let i = 0; i < 30; i++) candidates.push(mkQuote(`q${i}`, `author${i % 4}`));
  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(7));
  const ids = new Set(drawn.map((q) => q.id));
  assert.equal(ids.size, drawn.length);
});

test("drawQuotes tops up past the cap when there aren't enough distinct authors", () => {
  const candidates = [mkQuote("x1", "solo"), mkQuote("x2", "solo"), mkQuote("x3", "solo")];
  const drawn = game.drawQuotes(candidates, 3, "mixed", seededRng(1));
  assert.equal(drawn.length, 3);
});

test("submitAnswer rejects a second answer from the same player", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const authors = mkAuthors(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, authors, seededRng(3), 0);

  const first = game.submitAnswer(g, "p2", "host1", 1000);
  const second = game.submitAnswer(g, "p2", "p2", 1500);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(g.currentRound.answers.get("p2").authorId, "host1");
});

test("submitAnswer rejects an answer after the round deadline", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  const candidates = [mkQuote("q1", "host1")];
  const authors = mkAuthors(["host1"]);
  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, authors, seededRng(3), 0);

  const result = game.submitAnswer(g, "host1", "host1", 25000); // well past endsAt=20000
  assert.equal(result, false);
  assert.equal(g.currentRound.answers.size, 0);
});

test("nextRound and game:start are host-only", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1")];
  const authors = mkAuthors(["host1"]);

  assert.throws(
    () => game.startGame(g, "p2", { rounds: 1, roundSeconds: 20 }, candidates, authors, seededRng(1), 0),
    game.GameError
  );

  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, authors, seededRng(1), 0);
  game.revealRound(g, 5000);
  assert.throws(() => game.nextRound(g, "p2", seededRng(1), 6000), game.GameError);
});

test("scoring: correct answer awards 100 + speed bonus, wrong answer awards 0", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "fast", "Fast");
  game.addPlayer(g, "slow", "Slow");
  game.addPlayer(g, "wrong", "Wrong");
  game.addPlayer(g, "absent", "Absent");
  const candidates = [mkQuote("q1", "host1")];
  const authors = mkAuthors(["host1", "fast", "slow", "wrong", "absent"]);
  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, authors, seededRng(9), 0);
  // round starts at t=0, endsAt=20000

  game.submitAnswer(g, "fast", "host1", 1000); // 19s remaining
  game.submitAnswer(g, "slow", "host1", 19000); // 1s remaining
  game.submitAnswer(g, "wrong", "p2-does-not-exist", 5000);
  // "absent" never answers

  const reveal = game.revealRound(g, 20000);
  const byPlayer = Object.fromEntries(reveal.guesses.map((gs) => [gs.playerId, gs]));

  assert.equal(byPlayer.fast.correct, true);
  assert.equal(byPlayer.fast.points, 100 + Math.round(50 * (19 / 20)));
  assert.equal(byPlayer.slow.correct, true);
  assert.equal(byPlayer.slow.points, 100 + Math.round(50 * (1 / 20)));
  assert.equal(byPlayer.wrong.correct, false);
  assert.equal(byPlayer.wrong.points, 0);
  assert.equal(byPlayer.absent.correct, false);
  assert.equal(byPlayer.absent.points, 0);
  assert.ok(byPlayer.fast.points > byPlayer.slow.points, "faster answer should score more");
});

test("buildChoices always includes the correct author exactly once", () => {
  const quote = mkQuote("q1", "author3");
  const authors = mkAuthors(["author1", "author2", "author3", "author4", "author5"]);
  const choices = game.buildChoices(quote, authors, seededRng(2));
  const matches = choices.filter((c) => c.id === "author3");
  assert.equal(matches.length, 1);
});

test("rejoinByName reattaches a disconnected player within the grace period, not after", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Riley");
  game.markDisconnected(g, "p2", 1000);

  const withinGrace = game.rejoinByName(g, "Riley", 1000 + game.REJOIN_GRACE_MS - 1);
  assert.equal(withinGrace, "p2");

  game.markDisconnected(g, "p2", 1000);
  const afterGrace = game.rejoinByName(g, "Riley", 1000 + game.REJOIN_GRACE_MS + 1);
  assert.equal(afterGrace, null);
});

test("host disconnect promotes the oldest remaining connected player", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  game.addPlayer(g, "p3", "Player Three");
  game.markDisconnected(g, "host1", 1000);
  assert.equal(g.hostId, "p2");
});
