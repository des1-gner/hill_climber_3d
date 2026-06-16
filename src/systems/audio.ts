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

// --- Engine loop (continuous, multi-oscillator for a meaty motor sound) ---

function startEngine(): void {
  if (!ctx || !masterGain) return;
  engineGain = ctx.createGain();
  engineGain.gain.value = 0.06;
  engineGain.connect(masterGain);

  // Layer 1: very low fundamental rumble (custom periodic wave for asymmetric
  // combustion pulse rather than a pure tone).
  engineOsc = ctx.createOscillator();
  const real = new Float32Array([0, 1, 0.6, 0.3, 0.15, 0.08]);
  const imag = new Float32Array(real.length);
  const customWave = ctx.createPeriodicWave(real, imag);
  engineOsc.setPeriodicWave(customWave);
  engineOsc.frequency.value = 22;

  // Layer 2: sub-harmonic throb (adds chest-punch at low RPM).
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = 11;

  // Layer 3: mid growl with slight detune for width/variation.
  const osc3 = ctx.createOscillator();
  osc3.type = 'triangle';
  osc3.frequency.value = 44;
  osc3.detune.value = 7; // slight detune = organic variation

  // Layer 4: noise-modulated crackle for exhaust texture.
  const noiseLen = ctx.sampleRate * 2;
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) noiseData[i] = (Math.random() * 2 - 1);
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = noiseBuf;
  noiseSrc.loop = true;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.012;

  // Band-pass the noise around the engine frequency for exhaust pop character.
  const noiseBP = ctx.createBiquadFilter();
  noiseBP.type = 'bandpass';
  noiseBP.frequency.value = 120;
  noiseBP.Q.value = 0.8;

  // Master low-pass: cuts all harsh highs (kills the fly/buzz sound).
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 200;
  lpf.Q.value = 1.2;

  // Gain staging.
  const osc2Gain = ctx.createGain();
  osc2Gain.gain.value = 0.4;
  const osc3Gain = ctx.createGain();
  osc3Gain.gain.value = 0.2;

  engineOsc.connect(lpf);
  osc2.connect(osc2Gain).connect(lpf);
  osc3.connect(osc3Gain).connect(lpf);
  noiseSrc.connect(noiseBP).connect(noiseGain).connect(lpf);
  lpf.connect(engineGain);

  engineOsc.start();
  osc2.start();
  osc3.start();
  noiseSrc.start();

  // Store extras for per-frame frequency updates.
  (engineOsc as unknown as Record<string, unknown>)._osc2 = osc2;
  (engineOsc as unknown as Record<string, unknown>)._osc3 = osc3;
  (engineOsc as unknown as Record<string, unknown>)._lpf = lpf;
  (engineOsc as unknown as Record<string, unknown>)._noiseBP = noiseBP;
  (engineOsc as unknown as Record<string, unknown>)._noiseGain = noiseGain;
}

/**
 * Update the engine sound based on throttle and speed. Call every frame.
 * Deep idle rumble → throaty mid-range → growling top end.
 */
export function updateEngineSound(throttle: number, speed: number): void {
  if (!engineOsc || !engineGain || !ctx) return;

  // Simulate RPM: idle ~22 Hz fundamental, redline ~75 Hz.
  const rpm = 22 + Math.min(speed, 28) * 1.8 + throttle * 12;

  engineOsc.frequency.setTargetAtTime(rpm, ctx.currentTime, 0.1);

  const extras = engineOsc as unknown as Record<string, unknown>;
  const osc2 = extras._osc2 as OscillatorNode | undefined;
  const osc3 = extras._osc3 as OscillatorNode | undefined;
  const lpf = extras._lpf as BiquadFilterNode | undefined;
  const noiseBP = extras._noiseBP as BiquadFilterNode | undefined;
  const noiseGain = extras._noiseGain as GainNode | undefined;

  if (osc2) osc2.frequency.setTargetAtTime(rpm * 0.5, ctx.currentTime, 0.1);
  if (osc3) osc3.frequency.setTargetAtTime(rpm * 2, ctx.currentTime, 0.1);

  // Filter opens with RPM — brighter at higher revs but still capped low.
  if (lpf) lpf.frequency.setTargetAtTime(140 + rpm * 2, ctx.currentTime, 0.1);
  // Noise band follows RPM for exhaust crackle at all speeds.
  if (noiseBP) noiseBP.frequency.setTargetAtTime(rpm * 3, ctx.currentTime, 0.1);
  // More exhaust crackle under throttle.
  if (noiseGain) noiseGain.gain.setTargetAtTime(0.008 + throttle * 0.02, ctx.currentTime, 0.08);

  // Volume: louder under throttle, quiet rumble at idle.
  const vol = 0.025 + throttle * 0.08 + Math.min(speed, 22) * 0.002;
  engineGain.gain.setTargetAtTime(vol, ctx.currentTime, 0.08);
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

/** Creature hit/death squeak. */
export function playCreatureHit(): void {
  if (!ctx || !masterGain) return;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 800;
  osc.frequency.setTargetAtTime(300, ctx.currentTime + 0.05, 0.04);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.2, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
  osc.connect(g).connect(masterGain);
  osc.start();
  osc.stop(ctx.currentTime + 0.25);
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
