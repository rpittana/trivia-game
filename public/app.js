"use strict";

const socket = io();

const state = {
  roomCode: null,
  playerId: null,
  isHost: false,
  players: [],
  lastChoices: [],
  answered: false,
  people: new Map(), // personId -> { name, color }, from game:meta
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

// ---------- Sound mute toggle ----------

const muteBtn = document.getElementById("btn-mute");
function updateMuteIcon() {
  muteBtn.textContent = window.Sound && window.Sound.isMuted() ? "🔇" : "🔊";
}
updateMuteIcon();
muteBtn.addEventListener("click", () => {
  if (!window.Sound) return;
  window.Sound.setMuted(!window.Sound.isMuted());
  updateMuteIcon();
});

// ---------- Join screen ----------

document.getElementById("join-name").value = persistedName();
document.getElementById("join-name").focus();

for (const id of ["join-name", "join-code"]) {
  document.getElementById(id).addEventListener("input", (e) => e.target.classList.remove("input-error"));
}

document.getElementById("btn-create").addEventListener("click", () => {
  if (window.Sound) window.Sound.unlock(); // first user gesture — browsers block audio before this
  const name = document.getElementById("join-name").value.trim();
  if (!name) return showJoinError("Enter your name first.");
  sessionStorage.setItem("trivia_name", name);
  socket.emit("room:create", { name }, (res) => {
    if (res.error) return showJoinError(res.error);
    onJoined(res);
  });
});

document.getElementById("btn-join").addEventListener("click", () => {
  if (window.Sound) window.Sound.unlock();
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

socket.on("game:meta", ({ people }) => {
  state.people = new Map(people.map((p) => [p.id, { name: p.name, color: p.color }]));
  const legend = document.getElementById("lobby-color-legend");
  legend.innerHTML = "";
  for (const p of people) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="color-dot" style="background:${p.color}"></span>${p.name}`;
    legend.appendChild(li);
  }
});

socket.on("lobby:update", ({ players, settings }) => {
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

  if (settings) {
    document.getElementById("opt-rounds").value = settings.rounds;
    document.getElementById("opt-seconds").value = settings.roundSeconds;
    document.getElementById("opt-pool").value = settings.pool;
    document.getElementById("opt-show-year").checked = !!settings.showYear;
  }

  document.getElementById("host-controls").classList.toggle("hidden", !state.isHost);
  document.getElementById("lobby-waiting").classList.toggle("hidden", state.isHost);
});

socket.on("game:lobby", () => {
  showScreen("lobby");
});

document.getElementById("btn-start").addEventListener("click", () => {
  const rounds = parseInt(document.getElementById("opt-rounds").value, 10) || 15;
  const roundSeconds = parseInt(document.getElementById("opt-seconds").value, 10) || 20;
  const pool = document.getElementById("opt-pool").value;
  const showYear = document.getElementById("opt-show-year").checked;
  socket.emit("game:start", { rounds, roundSeconds, pool, showYear });
});

// ---------- Round ----------

let timerInterval = null;

socket.on("round:start", ({ roundNumber, totalRounds, quote, choices, endsAt }) => {
  state.answered = false;
  state.lastChoices = choices;
  state.currentQuoteContent = quote.content;
  showScreen("round");
  if (window.Sound) window.Sound.roundStart();

  document.getElementById("round-count").textContent = `Round ${roundNumber} / ${totalRounds}`;
  document.getElementById("round-quote").textContent = quote.content;
  document.getElementById("round-answered").textContent = "";

  const yearBadge = document.getElementById("round-year");
  if (quote.year) {
    yearBadge.textContent = quote.year;
    yearBadge.classList.remove("hidden");
  } else {
    yearBadge.classList.add("hidden");
  }

  const choicesEl = document.getElementById("round-choices");
  choicesEl.innerHTML = "";
  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.textContent = choice.displayName;
    btn.className = "choice-btn";
    btn.style.setProperty("--choice-color", choice.color);
    btn.addEventListener("click", () => {
      if (state.answered) return;
      state.answered = true;
      if (window.Sound) window.Sound.locked();
      socket.emit("round:answer", { personId: choice.personId });
      for (const b of choicesEl.querySelectorAll("button")) b.disabled = true;
      btn.classList.add("selected");
    });
    choicesEl.appendChild(btn);
  }

  clearInterval(timerInterval);
  const fill = document.getElementById("round-timer-fill");
  fill.classList.remove("timer-warning", "timer-danger");
  fill.style.width = "100%";
  const totalMs = endsAt - Date.now();
  let lastTickSecond = null;
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, endsAt - Date.now());
    fill.style.width = `${(remaining / totalMs) * 100}%`;
    fill.classList.toggle("timer-warning", remaining > 2000 && remaining <= 5000);
    fill.classList.toggle("timer-danger", remaining > 0 && remaining <= 2000);
    const wholeSecLeft = Math.ceil(remaining / 1000);
    if (remaining > 0 && remaining <= 5000 && wholeSecLeft !== lastTickSecond) {
      lastTickSecond = wholeSecLeft;
      if (window.Sound) window.Sound.tick();
    }
    if (remaining <= 0) clearInterval(timerInterval);
  }, 100);
});

socket.on("round:progress", ({ answeredPlayerIds }) => {
  document.getElementById("round-answered").textContent = `${answeredPlayerIds.length}/${state.players.length} answered`;
});

// ---------- Reveal ----------

socket.on("round:reveal", ({ correctPersonId, sentAt, guesses, scores }) => {
  clearInterval(timerInterval);
  showScreen("reveal");

  const correctChoice = state.lastChoices.find((c) => c.personId === correctPersonId);
  const correctName = correctChoice ? correctChoice.displayName : "someone";
  const headingEl = document.getElementById("reveal-heading");
  headingEl.textContent = `It was ${correctName}!`;
  headingEl.style.color = correctChoice ? correctChoice.color : "";
  document.getElementById("reveal-quote").textContent = state.currentQuoteContent || "";
  document.getElementById("reveal-date").textContent = sentAt
    ? `Sent ${new Date(sentAt).toLocaleDateString(undefined, { year: "numeric", month: "long" })}`
    : "";

  const list = document.getElementById("reveal-guesses");
  list.innerHTML = "";
  for (const g of guesses) {
    const player = state.players.find((p) => p.id === g.playerId);
    const guessChoice = state.lastChoices.find((c) => c.personId === g.personId);
    const li = document.createElement("li");
    li.className = g.correct ? "correct" : "incorrect";
    const guessedText = guessChoice ? guessChoice.displayName : "no answer";
    li.textContent = `${player ? player.name : "?"}: guessed ${guessedText} (+${g.points})`;
    list.appendChild(li);
  }

  renderScores("reveal-scores", [...scores].sort((a, b) => b.score - a.score), { animate: true });

  document.getElementById("btn-next").classList.toggle("hidden", !state.isHost);
  document.getElementById("reveal-waiting").classList.toggle("hidden", state.isHost);

  document.getElementById("btn-downvote").disabled = false;
  document.getElementById("btn-upvote").disabled = false;
  document.getElementById("downvote-count").textContent = "";
  document.getElementById("upvote-count").textContent = "";

  // Full-card flash + sound + confetti, based on whether I personally got it right.
  const revealScreen = screens.reveal;
  revealScreen.classList.remove("flash-correct", "flash-incorrect");
  void revealScreen.offsetWidth; // restart the flash animation on repeated reveals
  const myGuess = guesses.find((g) => g.playerId === state.playerId);
  if (myGuess && myGuess.personId != null) {
    if (myGuess.correct) {
      revealScreen.classList.add("flash-correct");
      if (window.Sound) window.Sound.correct();
      if (window.Effects) window.Effects.confettiBurst();
    } else {
      revealScreen.classList.add("flash-incorrect");
      if (window.Sound) window.Sound.wrong();
    }
  }
});

document.getElementById("btn-next").addEventListener("click", () => {
  socket.emit("round:next");
});

function lockVoteButtons() {
  document.getElementById("btn-downvote").disabled = true;
  document.getElementById("btn-upvote").disabled = true;
}

document.getElementById("btn-downvote").addEventListener("click", () => {
  lockVoteButtons();
  socket.emit("quote:downvote");
});

document.getElementById("btn-upvote").addEventListener("click", () => {
  lockVoteButtons();
  socket.emit("quote:upvote");
});

socket.on("quote:downvoted", ({ count }) => {
  document.getElementById("downvote-count").textContent = `(${count})`;
});

socket.on("quote:upvoted", ({ count }) => {
  document.getElementById("upvote-count").textContent = `(${count})`;
});

// ---------- Game over ----------

socket.on("game:over", ({ finalScores, guessability, thisGame }) => {
  showScreen("gameover");
  renderScores("final-scores", finalScores, { animate: true, crownFirst: true });
  renderPredictabilityBoard("this-game-board", "this-game-list", thisGame || []);
  renderPredictabilityBoard("predictability-board", "predictability-list", guessability || []);
  document.getElementById("btn-to-lobby").classList.toggle("hidden", !state.isHost);
  document.getElementById("gameover-waiting").classList.toggle("hidden", state.isHost);
  if (window.Sound) window.Sound.gameOver();
  if (window.Effects) window.Effects.confettiBurst(70);
});

function renderPredictabilityBoard(boardId, listId, entries) {
  const board = document.getElementById(boardId);
  const list = document.getElementById(listId);
  board.classList.toggle("hidden", entries.length === 0);
  list.innerHTML = "";
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    const icon = i === 0 ? "🔮" : i === entries.length - 1 ? "🎭" : "";
    const person = state.people.get(entry.personId);
    if (person) {
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.background = person.color;
      li.appendChild(dot);
    }
    li.appendChild(
      document.createTextNode(`${icon} ${entry.name} — ${entry.pct}% guessed right (${entry.sample} guesses)`.trim())
    );
    list.appendChild(li);
  });
}

document.getElementById("btn-to-lobby").addEventListener("click", () => {
  socket.emit("game:to-lobby");
});

const prevScores = new Map(); // playerId -> last-rendered score, for count-up animation

function renderScores(elId, scores, { animate = false, crownFirst = false } = {}) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  scores.forEach((s, i) => {
    const li = document.createElement("li");
    if (crownFirst && i === 0) li.classList.add("winner");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = `${crownFirst && i === 0 ? "👑 " : ""}${s.name} — `;
    const scoreSpan = document.createElement("span");
    li.appendChild(nameSpan);
    li.appendChild(scoreSpan);
    el.appendChild(li);

    const from = animate && prevScores.has(s.playerId) ? prevScores.get(s.playerId) : s.score;
    if (window.Effects) window.Effects.countUp(scoreSpan, from, s.score);
    else scoreSpan.textContent = s.score;
    prevScores.set(s.playerId, s.score);
  });
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
