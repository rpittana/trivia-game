// Lightweight visual effects — self-contained DOM particles, no libraries.
// Respects prefers-reduced-motion: everything here becomes a no-op when set.
"use strict";

const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const CONFETTI_COLORS = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7"];

function confettiBurst(count = 40) {
  if (REDUCE_MOTION) return;
  const container = document.createElement("div");
  container.className = "confetti-container";
  document.body.appendChild(container);

  for (let i = 0; i < count; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDelay = `${Math.random() * 0.3}s`;
    piece.style.animationDuration = `${1.2 + Math.random() * 0.8}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 200}px`);
    piece.style.setProperty("--spin", `${360 + Math.random() * 360}deg`);
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 2200);
}

/** Animates a number counting up from `from` to `to` inside `el`, in place of a static textContent set. */
function countUp(el, from, to, duration = 600) {
  if (REDUCE_MOTION || from === to) {
    el.textContent = to;
    return;
  }
  const start = performance.now();
  function step(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

window.Effects = { confettiBurst, countUp, REDUCE_MOTION };
