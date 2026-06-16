// Audio system — procedural sound effects using the Web Audio API.
//
// All sounds are synthesised from oscillators and noise (no external audio
// files needed). The system is lazily initialised on the first user interaction
// (to satisfy browser autoplay policies) and provides methods the game loop
// calls for each event.

/** Initialised lazily on first user gesture. */
let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let engineOsc: OscillatorNode | null = null;
let engineGain: GainNode | null = null;
let initialised = false;

function ensureCtx(): AudioContext | null {
  if (initialised) return ctx;
  if (typeof AudioContext === 'undefined') return null;
  try {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(ctx.destination);
    initialised = true;
    startEngine();
    return ctx;
  } catch {
    return null;
  }
}

/** Resume the audio context (call on user gesture). */
export function resumeAudio(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') {
    void c.resume();
  }
}

// --- Engine loop (continuous, pitch varies with speed) ---

function startEngine(): void {
  if (!ctx || !masterGain) return;
  engineGain = ctx.createGain();
  engineGain.gain.value = 0.08;
  engineGain.connect(masterGain);

  engineOsc = ctx.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.value = 60;
  engineOsc.connect(engineGain);
  engineOsc.start();
}

/**
 * Update the engine sound based on throttle and speed. Call every frame.
 *
 * @param throttle 0..1
 * @param speed m/s (absolute)
 */
export function updateEngineSound(throttle: number, speed: number): void {
  if (!engineOsc || !engineGain || !ctx) return;
  // Pitch rises with speed (idle ~60 Hz, top ~220 Hz).
  const freq = 60 + Math.min(speed, 30) * 5 + throttle * 40;
  engineOsc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
  // Volume rises with throttle.
  const vol = 0.04 + throttle * 0.12;
  engineGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.05);
}

// --- One-shot effects ---

function noise(duration: number, volume: number): void {
  if (!ctx || !masterGain) return;
  const bufSize = Math.ceil(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * volume;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  src.connect(gain).connect(masterGain);
  src.start();
}

/** Crash / impact sound — a burst of noise + low thud. */
export function playCrash(intensity: number): void {
  if (!ctx || !masterGain) return;
  const vol = Math.min(1, intensity) * 0.5;
  noise(0.15 + intensity * 0.1, vol);
  // Low thud.
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 50 + intensity * 30;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol * 0.6, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
  osc.connect(g).connect(masterGain);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
}

/** Glass shatter sound — high-frequency noise burst. */
export function playGlassShatter(): void {
  if (!ctx || !masterGain) return;
  // High-pass filtered noise for that tinkly glass sound.
  const bufSize = Math.ceil(ctx.sampleRate * 0.3);
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 3000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.35, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  src.connect(filter).connect(gain).connect(masterGain);
  src.start();
}

/** Tree crack / uproot sound. */
export function playTreeCrack(): void {
  if (!ctx || !masterGain) return;
  noise(0.25, 0.3);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 80;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.2, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.connect(g).connect(masterGain);
  osc.start();
  osc.stop(ctx.currentTime + 0.2);
}

/** Fuel pickup jingle. */
export function playPickup(): void {
  if (!ctx || !masterGain) return;
  const now = ctx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 600 + i * 200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, now + i * 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.15);
    osc.connect(g).connect(masterGain!);
    osc.start(now + i * 0.08);
    osc.stop(now + i * 0.08 + 0.2);
  }
}

/** Checkpoint reached chime. */
export function playCheckpoint(): void {
  if (!ctx || !masterGain) return;
  const now = ctx.currentTime;
  const notes = [523, 659, 784]; // C5, E5, G5
  for (let i = 0; i < notes.length; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = notes[i]!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2, now + i * 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.3);
    osc.connect(g).connect(masterGain!);
    osc.start(now + i * 0.1);
    osc.stop(now + i * 0.1 + 0.35);
  }
}
