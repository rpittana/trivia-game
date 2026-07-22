// Synthesized sound effects via the Web Audio API — no asset files, no CDN.
"use strict";

const MUTE_KEY = "trivia_muted";
let audioCtx = null;
let muted = localStorage.getItem(MUTE_KEY) === "1";

function ensureContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone({ freq, duration = 0.15, type = "sine", startTime = 0, gain = 0.15, freqEnd = null }) {
  if (muted) return;
  const ctx = ensureContext();
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = type;
  const t0 = ctx.currentTime + startTime;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.linearRampToValueAtTime(freqEnd, t0 + duration);
  gainNode.gain.setValueAtTime(gain, t0);
  gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gainNode).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

window.Sound = {
  isMuted: () => muted,
  setMuted(value) {
    muted = value;
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  },
  unlock: ensureContext, // call on the first user gesture (create/join click) — browsers block audio before that
  roundStart() {
    tone({ freq: 440, duration: 0.12, type: "triangle" });
  },
  locked() {
    tone({ freq: 600, duration: 0.05, type: "square", gain: 0.08 });
  },
  correct() {
    tone({ freq: 523.25, duration: 0.12 });
    tone({ freq: 659.25, duration: 0.12, startTime: 0.1 });
    tone({ freq: 783.99, duration: 0.22, startTime: 0.2 });
  },
  wrong() {
    tone({ freq: 160, duration: 0.35, type: "sawtooth", gain: 0.12, freqEnd: 90 });
  },
  tick() {
    tone({ freq: 880, duration: 0.06, type: "square", gain: 0.06 });
  },
  gameOver() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) =>
      tone({ freq, duration: 0.22, type: "triangle", startTime: i * 0.12 })
    );
  },
};
