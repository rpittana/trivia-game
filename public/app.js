"use strict";

const socket = io();

const state = {
  roomCode: null,
  playerId: null,
  isHost: false,
  players: [],
  lastChoices: [],
  answered: false,
};

const screens = {
  join: document.getElementById("screen-join"),
  lobby: document.getElementById("screen-lobby"),
  round: document.getElementById("screen-round"),
  reveal: document.getElementById("screen-reveal"),
  gameover: document.getElementById("screen-gameover"),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle("active", key === name);
}

function persistedName() {
  return sessionStorage.getItem("trivia_name") || "";
}

// ---------- Join screen ----------

document.getElementById("join-name").value = persistedName();
document.getElementById("join-name").focus();

for (const id of ["join-name", "join-code"]) {
  document.getElementById(id).addEventListener("input", (e) => e.target.classList.remove("input-error"));
}

document.getElementById("btn-create").addEventListener("click", () => {
  const name = document.getElementById("join-name").value.trim();
  if (!name) return showJoinError("Enter your name first.");
  sessionStorage.setItem("trivia_name", name);
  socket.emit("room:create", { name }, (res) => {
    if (res.error) return showJoinError(res.error);
    onJoined(res);
  });
});

document.getElementById("btn-join").addEventListener("click", () => {
  const name = document.getElementById("join-name").value.trim();
  const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
  if (!name) return showJoinError("Enter your name first.");
  if (!roomCode) return showJoinError("Enter a room code.", "join-code");
  sessionStorage.setItem("trivia_name", name);
  socket.emit("room:join", { roomCode, name }, (res) => {
    if (res.error) return showJoinError(res.error);
    onJoined(res);
  });
});

function showJoinError(msg, fieldId = "join-name") {
  const errorEl = document.getElementById("join-error");
  errorEl.textContent = msg;
  const field = document.getElementById(fieldId);
  field.classList.remove("shake");
  field.classList.add("input-error");
  // eslint-disable-next-line no-unused-expressions
  field.offsetWidth; // restart the animation on repeated errors
  field.classList.add("shake");
  field.focus();
}

function onJoined({ roomCode, playerId }) {
  state.roomCode = roomCode;
  state.playerId = playerId;
  sessionStorage.setItem("trivia_room", roomCode);
  document.getElementById("lobby-code").textContent = roomCode;
  showScreen("lobby");
}

// ---------- Lobby ----------

socket.on("lobby:update", ({ players }) => {
  state.players = players;
  const me = players.find((p) => p.id === state.playerId);
  state.isHost = !!(me && me.isHost);

  const list = document.getElementById("lobby-players");
  list.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    li.textContent = p.name + (p.isHost ? " (host)" : "");
    list.appendChild(li);
  }

  document.getElementById("host-controls").classList.toggle("hidden", !state.isHost);
  document.getElementById("lobby-waiting").classList.toggle("hidden", state.isHost);
});

document.getElementById("btn-start").addEventListener("click", () => {
  const rounds = parseInt(document.getElementById("opt-rounds").value, 10) || 15;
  const roundSeconds = parseInt(document.getElementById("opt-seconds").value, 10) || 20;
  const pool = document.getElementById("opt-pool").value;
  socket.emit("game:start", { rounds, roundSeconds, pool });
});

// ---------- Round ----------

let timerInterval = null;

socket.on("round:start", ({ roundNumber, totalRounds, quote, choices, endsAt }) => {
  state.answered = false;
  state.lastChoices = choices;
  showScreen("round");

  document.getElementById("round-count").textContent = `Round ${roundNumber} / ${totalRounds}`;
  document.getElementById("round-quote").textContent = quote.content;
  document.getElementById("round-answered").textContent = "";

  const choicesEl = document.getElementById("round-choices");
  choicesEl.innerHTML = "";
  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.textContent = choice.displayName;
    btn.className = "choice-btn";
    btn.addEventListener("click", () => {
      if (state.answered) return;
      state.answered = true;
      socket.emit("round:answer", { authorId: choice.authorId });
      for (const b of choicesEl.querySelectorAll("button")) b.disabled = true;
      btn.classList.add("selected");
    });
    choicesEl.appendChild(btn);
  }

  clearInterval(timerInterval);
  const fill = document.getElementById("round-timer-fill");
  const totalMs = endsAt - Date.now();
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, endsAt - Date.now());
    fill.style.width = `${(remaining / totalMs) * 100}%`;
    if (remaining <= 0) clearInterval(timerInterval);
  }, 100);
});

socket.on("round:progress", ({ answeredPlayerIds }) => {
  document.getElementById("round-answered").textContent = `${answeredPlayerIds.length}/${state.players.length} answered`;
});

// ---------- Reveal ----------

socket.on("round:reveal", ({ correctAuthorId, sentAt, guesses, scores }) => {
  clearInterval(timerInterval);
  showScreen("reveal");

  const correctChoice = state.lastChoices.find((c) => c.authorId === correctAuthorId);
  const correctName = correctChoice ? correctChoice.displayName : "someone";
  document.getElementById("reveal-heading").textContent = `It was ${correctName}!`;
  document.getElementById("reveal-date").textContent = sentAt
    ? `Sent ${new Date(sentAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })}`
    : "";

  const list = document.getElementById("reveal-guesses");
  list.innerHTML = "";
  for (const g of guesses) {
    const player = state.players.find((p) => p.id === g.playerId);
    const guessChoice = state.lastChoices.find((c) => c.authorId === g.authorId);
    const li = document.createElement("li");
    li.className = g.correct ? "correct" : "incorrect";
    const guessedText = guessChoice ? guessChoice.displayName : "no answer";
    li.textContent = `${player ? player.name : "?"}: guessed ${guessedText} (+${g.points})`;
    list.appendChild(li);
  }

  renderScores("reveal-scores", [...scores].sort((a, b) => b.score - a.score));

  document.getElementById("btn-next").classList.toggle("hidden", !state.isHost);
  document.getElementById("reveal-waiting").classList.toggle("hidden", state.isHost);
});

document.getElementById("btn-next").addEventListener("click", () => {
  socket.emit("round:next");
});

// ---------- Game over ----------

socket.on("game:over", ({ finalScores }) => {
  showScreen("gameover");
  renderScores("final-scores", finalScores);
  document.getElementById("btn-again").classList.toggle("hidden", !state.isHost);
  document.getElementById("gameover-waiting").classList.toggle("hidden", state.isHost);
});

document.getElementById("btn-again").addEventListener("click", () => {
  socket.emit("game:again");
});

function renderScores(elId, scores) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  for (const s of scores) {
    const li = document.createElement("li");
    li.textContent = `${s.name} — ${s.score}`;
    el.appendChild(li);
  }
}

// ---------- Errors ----------

socket.on("error", ({ message }) => {
  console.error("Server error:", message);
  alert(message);
});

// ---------- Reconnect ----------

socket.on("connect", () => {
  const savedRoom = sessionStorage.getItem("trivia_room");
  const savedName = persistedName();
  if (savedRoom && savedName && !state.roomCode) {
    socket.emit("room:join", { roomCode: savedRoom, name: savedName }, (res) => {
      if (!res.error) onJoined(res);
    });
  }
});
