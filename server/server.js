"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const http = require("http");

const game = require("./game");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity

const app = express();

// Defense in depth: the raw export and quotes.db must never be servable, even by accident.
app.use("/data", (req, res) => res.status(403).end());
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, ReturnType<typeof game.createGame>>} */
const rooms = new Map();
/** @type {Map<string, {expiryTimer: NodeJS.Timeout|null, advanceTimer: NodeJS.Timeout|null}>} */
const roomTimers = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join(
      ""
    );
  } while (rooms.has(code));
  return code;
}

function getTimers(roomCode) {
  if (!roomTimers.has(roomCode)) roomTimers.set(roomCode, { expiryTimer: null, advanceTimer: null });
  return roomTimers.get(roomCode);
}

function clearTimers(roomCode) {
  const t = roomTimers.get(roomCode);
  if (!t) return;
  if (t.expiryTimer) clearTimeout(t.expiryTimer);
  if (t.advanceTimer) clearTimeout(t.advanceTimer);
  t.expiryTimer = null;
  t.advanceTimer = null;
}

function broadcastLobby(roomCode) {
  const g = rooms.get(roomCode);
  if (!g) return;
  io.to(roomCode).emit("lobby:update", {
    players: [...g.players.values()]
      .filter((p) => p.connected)
      .map((p) => ({ id: p.id, name: p.name, isHost: p.id === g.hostId })),
    settings: g.settings,
  });
}

function emitRoundStart(roomCode, round, roundNumber) {
  const g = rooms.get(roomCode);
  io.to(roomCode).emit("round:start", {
    roundNumber,
    totalRounds: g.settings.rounds,
    quote: { content: round.quote.content },
    choices: round.choices.map((p) => ({ personId: p.id, displayName: p.displayName })),
    endsAt: round.endsAt,
  });
}

function scheduleExpiry(roomCode) {
  const timers = getTimers(roomCode);
  const g = rooms.get(roomCode);
  const msLeft = Math.max(0, g.currentRound.endsAt - Date.now());
  timers.expiryTimer = setTimeout(() => doReveal(roomCode), msLeft + 50);
}

function scheduleAutoAdvance(roomCode) {
  const timers = getTimers(roomCode);
  timers.advanceTimer = setTimeout(() => doAdvance(roomCode), 6000);
}

function doReveal(roomCode) {
  const g = rooms.get(roomCode);
  if (!g || g.status !== "in-progress" || !g.currentRound) return;
  clearTimers(roomCode);
  const payload = game.revealRound(g, Date.now());
  io.to(roomCode).emit("round:reveal", payload);
  scheduleAutoAdvance(roomCode);
}

function doAdvance(roomCode) {
  const g = rooms.get(roomCode);
  if (!g || g.status !== "reveal") return;
  clearTimers(roomCode);
  let round;
  try {
    round = game.nextRound(g, g.hostId, Math.random, Date.now());
  } catch (err) {
    return; // race with a manual advance that already happened
  }
  handleRoundResult(roomCode, round);
}

function handleRoundResult(roomCode, round) {
  const g = rooms.get(roomCode);
  if (round === null) {
    io.to(roomCode).emit("game:over", { finalScores: game.finalScores(g) });
    return;
  }
  db.incrementTimesPlayed(round.quote.id);
  emitRoundStart(roomCode, round, g.roundIndex + 1);
  scheduleExpiry(roomCode);
}

function cleanupEmptyRoom(roomCode) {
  const g = rooms.get(roomCode);
  if (!g) return;
  const anyoneLeft = [...g.players.values()].some((p) => p.connected);
  if (!anyoneLeft) {
    clearTimers(roomCode);
    roomTimers.delete(roomCode);
    rooms.delete(roomCode);
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, ack) => {
    try {
      const roomCode = generateRoomCode();
      const playerId = crypto.randomUUID();
      const g = game.createGame(roomCode, playerId, String(name || "Host").slice(0, 32));
      rooms.set(roomCode, g);
      socket.data.roomCode = roomCode;
      socket.data.playerId = playerId;
      socket.join(roomCode);
      ack && ack({ roomCode, playerId });
      broadcastLobby(roomCode);
    } catch (err) {
      ack && ack({ error: err.message });
    }
  });

  socket.on("room:join", ({ roomCode, name }, ack) => {
    const code = String(roomCode || "").toUpperCase();
    const g = rooms.get(code);
    if (!g) {
      ack && ack({ error: "Room not found." });
      return;
    }
    try {
      const cleanName = String(name || "Player").slice(0, 32);
      let playerId = game.rejoinByName(g, cleanName, Date.now());
      if (!playerId) {
        playerId = crypto.randomUUID();
        game.addPlayer(g, playerId, cleanName);
      }
      socket.data.roomCode = code;
      socket.data.playerId = playerId;
      socket.join(code);
      ack && ack({ roomCode: code, playerId });
      broadcastLobby(code);
    } catch (err) {
      ack && ack({ error: err.message });
    }
  });

  socket.on("game:start", (settings) => {
    const { roomCode, playerId } = socket.data;
    const g = rooms.get(roomCode);
    if (!g) return;
    try {
      const people = db.getPeople();
      const candidates = db.getCandidateQuotes();
      const round = game.startGame(g, playerId, settings || {}, candidates, people, Math.random, Date.now());
      db.incrementTimesPlayed(round.quote.id);
      emitRoundStart(roomCode, round, g.roundIndex + 1);
      scheduleExpiry(roomCode);
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("round:answer", ({ personId }) => {
    const { roomCode, playerId } = socket.data;
    const g = rooms.get(roomCode);
    if (!g) return;
    try {
      const accepted = game.submitAnswer(g, playerId, personId, Date.now());
      if (accepted) {
        io.to(roomCode).emit("round:progress", { answeredPlayerIds: [...g.currentRound.answers.keys()] });
        if (game.allAnswered(g)) doReveal(roomCode);
      }
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("round:next", () => {
    const { roomCode, playerId } = socket.data;
    const g = rooms.get(roomCode);
    if (!g) return;
    try {
      clearTimers(roomCode);
      const round = game.nextRound(g, playerId, Math.random, Date.now());
      handleRoundResult(roomCode, round);
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("game:again", () => {
    const { roomCode, playerId } = socket.data;
    const g = rooms.get(roomCode);
    if (!g) return;
    try {
      clearTimers(roomCode);
      const candidates = db.getCandidateQuotes();
      const { readyToStart } = game.playAgain(g, playerId, candidates, Math.random, Date.now());
      const round = readyToStart();
      db.incrementTimesPlayed(round.quote.id);
      emitRoundStart(roomCode, round, g.roundIndex + 1);
      scheduleExpiry(roomCode);
    } catch (err) {
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return;
    const g = rooms.get(roomCode);
    if (!g) return;
    game.markDisconnected(g, playerId, Date.now());
    broadcastLobby(roomCode);
    setTimeout(() => {
      const still = rooms.get(roomCode);
      if (!still) return;
      game.removeStalePlayers(still, Date.now());
      cleanupEmptyRoom(roomCode);
    }, game.REJOIN_GRACE_MS + 1000);
  });
});

server.listen(PORT, () => {
  console.log(`Discord trivia server listening on http://localhost:${PORT}`);
});
