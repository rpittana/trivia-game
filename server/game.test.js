"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const game = require("./game");

function mkQuote(id, personId, overrides = {}) {
  return {
    id,
    personId,
    content: `quote ${id}`,
    sentAt: "2024-01-01T00:00:00Z",
    humorScore: 50,
    interestScore: 50,
    timesPlayed: 0,
    ...overrides,
  };
}

function mkPeople(ids) {
  return ids.map((id) => ({ id, displayName: `person-${id}` }));
}

// deterministic PRNG for reproducible tests
function seededRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

test("drawQuotes allocates equal slots per person, redistributing shortfall (100/10/3 -> 6/6/3)", () => {
  const candidates = [];
  for (let i = 0; i < 100; i++) candidates.push(mkQuote(`a${i}`, "loud-friend"));
  for (let i = 0; i < 10; i++) candidates.push(mkQuote(`b${i}`, "medium-friend"));
  for (let i = 0; i < 3; i++) candidates.push(mkQuote(`c${i}`, "quiet-friend"));

  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(42));
  const counts = new Map();
  for (const q of drawn) counts.set(q.personId, (counts.get(q.personId) || 0) + 1);

  assert.equal(drawn.length, 15);
  assert.equal(counts.get("loud-friend"), 6);
  assert.equal(counts.get("medium-friend"), 6);
  assert.equal(counts.get("quiet-friend"), 3);
});

test("drawQuotes splits evenly with no shortfall", () => {
  const candidates = [];
  for (const person of ["p1", "p2", "p3"]) {
    for (let i = 0; i < 20; i++) candidates.push(mkQuote(`${person}-${i}`, person));
  }
  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(5));
  const counts = new Map();
  for (const q of drawn) counts.set(q.personId, (counts.get(q.personId) || 0) + 1);
  assert.equal(counts.get("p1"), 5);
  assert.equal(counts.get("p2"), 5);
  assert.equal(counts.get("p3"), 5);
});

test("drawQuotes never gives a 12/2/1-style lopsided draw", () => {
  const candidates = [];
  for (let i = 0; i < 100; i++) candidates.push(mkQuote(`a${i}`, "loud-friend"));
  for (let i = 0; i < 10; i++) candidates.push(mkQuote(`b${i}`, "medium-friend"));
  for (let i = 0; i < 3; i++) candidates.push(mkQuote(`c${i}`, "quiet-friend"));

  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(99));
  const counts = new Map();
  for (const q of drawn) counts.set(q.personId, (counts.get(q.personId) || 0) + 1);
  assert.notEqual(counts.get("loud-friend"), 12);
  assert.ok(counts.get("quiet-friend") >= 3);
});

test("drawQuotes excludes quotes at or above the downvote threshold", () => {
  const candidates = [
    mkQuote("bad1", "p1", { downvotes: game.DOWNVOTE_HIDE_THRESHOLD }),
    mkQuote("bad2", "p1", { downvotes: game.DOWNVOTE_HIDE_THRESHOLD + 5 }),
    mkQuote("ok1", "p1", { downvotes: game.DOWNVOTE_HIDE_THRESHOLD - 1 }),
    mkQuote("ok2", "p1", { downvotes: 0 }),
  ];
  const drawn = game.drawQuotes(candidates, 4, "mixed", seededRng(3));
  const ids = drawn.map((q) => q.id);
  assert.ok(!ids.includes("bad1"));
  assert.ok(!ids.includes("bad2"));
  assert.equal(ids.length, 2);
});

test("drawQuotes returns no duplicate quote ids", () => {
  const candidates = [];
  for (let i = 0; i < 30; i++) candidates.push(mkQuote(`q${i}`, `person${i % 4}`));
  const drawn = game.drawQuotes(candidates, 15, "mixed", seededRng(7));
  const ids = new Set(drawn.map((q) => q.id));
  assert.equal(ids.size, drawn.length);
});

test("drawQuotes tops out cleanly when there are very few distinct people", () => {
  const candidates = [mkQuote("x1", "solo"), mkQuote("x2", "solo"), mkQuote("x3", "solo")];
  const drawn = game.drawQuotes(candidates, 3, "mixed", seededRng(1));
  assert.equal(drawn.length, 3);
});

test("submitAnswer rejects a second answer from the same player", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, people, seededRng(3), 0);

  const first = game.submitAnswer(g, "p2", "host1", 1000);
  const second = game.submitAnswer(g, "p2", "p2", 1500);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(g.currentRound.answers.get("p2").personId, "host1");
});

test("submitAnswer rejects an answer after the round deadline", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  const candidates = [mkQuote("q1", "host1")];
  const people = mkPeople(["host1"]);
  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, people, seededRng(3), 0);

  const result = game.submitAnswer(g, "host1", "host1", 25000); // well past endsAt=20000
  assert.equal(result, false);
  assert.equal(g.currentRound.answers.size, 0);
});

test("nextRound and game:start are host-only", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1")];
  const people = mkPeople(["host1"]);

  assert.throws(
    () => game.startGame(g, "p2", { rounds: 1, roundSeconds: 20 }, candidates, people, seededRng(1), 0),
    game.GameError
  );

  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, people, seededRng(1), 0);
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
  const people = mkPeople(["host1", "fast", "slow", "wrong", "absent"]);
  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20 }, candidates, people, seededRng(9), 0);
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

test("thisGamePredictability tracks per-game accuracy and excludes people with zero guesses", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "fast", "Fast");
  game.addPlayer(g, "slow", "Slow");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, people, seededRng(11), 0);

  const round1AuthorId = g.currentRound.quote.personId;
  const otherId = round1AuthorId === "host1" ? "p2" : "host1";
  game.submitAnswer(g, "fast", round1AuthorId, 1000); // correct
  game.submitAnswer(g, "slow", otherId, 1000); // wrong
  game.revealRound(g, 20000);
  game.nextRound(g, "host1", seededRng(1), 21000);
  // nobody answers round 2 — reveal with zero guesses
  game.revealRound(g, 41000);

  const board = game.thisGamePredictability(g);
  assert.equal(board.length, 1, "the round-2 author had zero guesses and should be excluded");
  assert.equal(board[0].personId, round1AuthorId);
  assert.equal(board[0].sample, 2);
  assert.equal(board[0].pct, 50);
});

test("returnToLobby is host-only, resets status to lobby, and retains players + settings", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 1, roundSeconds: 20, pool: "funny", showYear: true }, candidates, people, seededRng(6), 0);
  game.revealRound(g, 20000);
  game.nextRound(g, "host1", seededRng(1), 21000); // round 2 doesn't exist -> game-over

  assert.throws(() => game.returnToLobby(g, "p2"), game.GameError, "non-host cannot return the room to lobby");

  game.returnToLobby(g, "host1");
  assert.equal(g.status, "lobby");
  assert.equal(g.currentRound, null);
  assert.equal(g.players.size, 2, "players stay in the room");
  assert.ok(g.players.has("host1") && g.players.has("p2"));
  assert.deepEqual(g.settings, { rounds: 1, roundSeconds: 20, pool: "funny", showYear: true }, "settings kept for lobby prefill");

  assert.throws(() => game.returnToLobby(g, "host1"), game.GameError, "can't return to lobby twice — game isn't over anymore");
});

test("downvoteCurrentQuote counts once per player per round", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, people, seededRng(4), 0);

  const first = game.downvoteCurrentQuote(g, "p2");
  const second = game.downvoteCurrentQuote(g, "p2");
  const third = game.downvoteCurrentQuote(g, "host1");
  assert.equal(first, true);
  assert.equal(second, false, "same player voting twice should not count again");
  assert.equal(third, true, "a different player can still vote");
});

test("upvoteCurrentQuote counts once per player per round", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, people, seededRng(4), 0);

  const first = game.upvoteCurrentQuote(g, "p2");
  const second = game.upvoteCurrentQuote(g, "p2");
  const third = game.upvoteCurrentQuote(g, "host1");
  assert.equal(first, true);
  assert.equal(second, false, "same player voting twice should not count again");
  assert.equal(third, true, "a different player can still vote");
});

test("a player's vote direction locks — the other direction is ignored afterward", () => {
  const g = game.createGame("ABCD", "host1", "Host");
  game.addPlayer(g, "p2", "Player Two");
  const candidates = [mkQuote("q1", "host1"), mkQuote("q2", "p2")];
  const people = mkPeople(["host1", "p2"]);
  game.startGame(g, "host1", { rounds: 2, roundSeconds: 20 }, candidates, people, seededRng(4), 0);

  assert.equal(game.downvoteCurrentQuote(g, "p2"), true);
  assert.equal(game.upvoteCurrentQuote(g, "p2"), false, "already downvoted this round — upvote is ignored");

  assert.equal(game.upvoteCurrentQuote(g, "host1"), true);
  assert.equal(game.downvoteCurrentQuote(g, "host1"), false, "already upvoted this round — downvote is ignored");
});

test("buildChoices always includes the correct person exactly once", () => {
  const quote = mkQuote("q1", "person3");
  const people = mkPeople(["person1", "person2", "person3", "person4", "person5"]);
  const choices = game.buildChoices(quote, people, seededRng(2));
  const matches = choices.filter((c) => c.id === "person3");
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
