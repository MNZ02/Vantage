// M5 audio: every sound effect is synthesized once at boot into an
// AudioBuffer via plain math (noise bursts, filtered taps, tone sweeps) —
// no binary assets, no external fetches. REAL-ASSET SWAP POINT: a future
// pass with recorded/mixed weapon and foley samples would replace this
// file's synthesize*() functions wholesale; engine.ts only ever consumes
// named AudioBuffers, so the swap wouldn't touch any other file.
import { weaponClassFor, type WeaponClass } from "../viewmodel.js";

function createBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  return ctx.createBuffer(1, length, ctx.sampleRate);
}

/** Deterministic PRNG so repeated boots sound identical (cosmetic only — no purity constraint outside sim/src). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillNoise(data: Float32Array, rand: () => number, envelope: (t01: number) => number): void {
  for (let i = 0; i < data.length; i++) {
    const t01 = i / data.length;
    data[i] = (rand() * 2 - 1) * envelope(t01);
  }
}

function addTone(data: Float32Array, sampleRate: number, freq: number, envelope: (t01: number) => number, amplitude: number, freqSweepTo?: number): void {
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const t01 = i / data.length;
    const f = freqSweepTo !== undefined ? freq + (freqSweepTo - freq) * t01 : freq;
    data[i] = data[i]! + Math.sin(2 * Math.PI * f * t) * envelope(t01) * amplitude;
  }
}

function expDecay(rate: number): (t01: number) => number {
  return (t01) => Math.exp(-rate * t01);
}

const WEAPON_CLASS_TUNING: Record<WeaponClass, { durationSec: number; noiseDecay: number; bodyFreq: number; tailDecay: number }> = {
  pistol: { durationSec: 0.18, noiseDecay: 14, bodyFreq: 220, tailDecay: 10 },
  smg: { durationSec: 0.16, noiseDecay: 16, bodyFreq: 200, tailDecay: 11 },
  rifle: { durationSec: 0.22, noiseDecay: 10, bodyFreq: 160, tailDecay: 7 },
  sniper: { durationSec: 0.45, noiseDecay: 5, bodyFreq: 90, tailDecay: 3 },
};

/** Gunshot = noise burst (crack) + a low body thump + a decaying tail. Sniper is boomier (lower freq, longer decay); pistol is snappier (short, high decay rate). */
function synthesizeGunshot(ctx: BaseAudioContext, weaponClass: WeaponClass, seed: number): AudioBuffer {
  const tuning = WEAPON_CLASS_TUNING[weaponClass];
  const buffer = createBuffer(ctx, tuning.durationSec);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(seed);
  fillNoise(data, rand, expDecay(tuning.noiseDecay));
  addTone(data, ctx.sampleRate, tuning.bodyFreq, expDecay(tuning.tailDecay), 0.6);
  addTone(data, ctx.sampleRate, tuning.bodyFreq * 0.5, expDecay(tuning.tailDecay * 1.5), 0.3);
  normalize(data, 0.9);
  return buffer;
}

function normalize(data: Float32Array, target: number): void {
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-6) return;
  const scale = target / peak;
  for (let i = 0; i < data.length; i++) data[i] = data[i]! * scale;
}

function synthesizeReloadClick(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const buffer = createBuffer(ctx, 0.06);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(seed);
  fillNoise(data, rand, expDecay(40));
  normalize(data, 0.6);
  return buffer;
}

function synthesizeFootstep(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const buffer = createBuffer(ctx, 0.09);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(seed);
  fillNoise(data, rand, expDecay(18));
  addTone(data, ctx.sampleRate, 90, expDecay(20), 0.25);
  normalize(data, 0.5);
  return buffer;
}

type AbilityCue = "whoosh" | "shimmer" | "rumble" | "crackle" | "chime" | "alarm";

function synthesizeAbilityCue(ctx: BaseAudioContext, cue: AbilityCue, seed: number): AudioBuffer {
  const rand = mulberry32(seed);
  switch (cue) {
    case "whoosh": {
      const buffer = createBuffer(ctx, 0.35);
      const data = buffer.getChannelData(0);
      fillNoise(data, rand, (t) => Math.sin(Math.PI * t) * 0.8);
      normalize(data, 0.5);
      return buffer;
    }
    case "shimmer": {
      const buffer = createBuffer(ctx, 0.5);
      const data = buffer.getChannelData(0);
      addTone(data, ctx.sampleRate, 2200, expDecay(3), 0.4, 3200);
      addTone(data, ctx.sampleRate, 1600, expDecay(4), 0.3, 2400);
      normalize(data, 0.7);
      return buffer;
    }
    case "rumble": {
      const buffer = createBuffer(ctx, 0.6);
      const data = buffer.getChannelData(0);
      addTone(data, ctx.sampleRate, 60, (t) => Math.sin(Math.PI * t), 0.6);
      fillNoise(data, rand, (t) => Math.sin(Math.PI * t) * 0.15);
      normalize(data, 0.6);
      return buffer;
    }
    case "crackle": {
      const buffer = createBuffer(ctx, 0.5);
      const data = buffer.getChannelData(0);
      fillNoise(data, rand, (t) => (rand() > 0.6 ? 1 : 0) * expDecay(2)(t));
      normalize(data, 0.6);
      return buffer;
    }
    case "chime": {
      const buffer = createBuffer(ctx, 0.4);
      const data = buffer.getChannelData(0);
      addTone(data, ctx.sampleRate, 880, expDecay(4), 0.5);
      addTone(data, ctx.sampleRate, 1320, expDecay(5), 0.3);
      normalize(data, 0.6);
      return buffer;
    }
    case "alarm": {
      const buffer = createBuffer(ctx, 0.3);
      const data = buffer.getChannelData(0);
      addTone(data, ctx.sampleRate, 1400, (t) => (Math.sin(t * 40) > 0 ? 1 : 0) * expDecay(2)(t), 0.5);
      normalize(data, 0.6);
      return buffer;
    }
  }
}

function synthesizeUiClick(ctx: BaseAudioContext): AudioBuffer {
  const buffer = createBuffer(ctx, 0.04);
  const data = buffer.getChannelData(0);
  addTone(data, ctx.sampleRate, 1000, expDecay(60), 0.5);
  normalize(data, 0.5);
  return buffer;
}

function synthesizeRoundStinger(ctx: BaseAudioContext, win: boolean): AudioBuffer {
  const buffer = createBuffer(ctx, 1.1);
  const data = buffer.getChannelData(0);
  const chord = win ? [261.6, 329.6, 392.0, 523.2] : [261.6, 311.1, 349.2];
  for (const freq of chord) {
    addTone(data, ctx.sampleRate, freq, expDecay(win ? 1.5 : 2.5), 0.2);
  }
  normalize(data, 0.7);
  return buffer;
}

function synthesizeHitConfirm(ctx: BaseAudioContext, headshot: boolean): AudioBuffer {
  const buffer = createBuffer(ctx, headshot ? 0.12 : 0.05);
  const data = buffer.getChannelData(0);
  addTone(data, ctx.sampleRate, headshot ? 1800 : 1200, expDecay(30), 0.6);
  if (headshot) addTone(data, ctx.sampleRate, 2600, expDecay(20), 0.4);
  normalize(data, 0.7);
  return buffer;
}

function synthesizeBeep(ctx: BaseAudioContext): AudioBuffer {
  const buffer = createBuffer(ctx, 0.08);
  const data = buffer.getChannelData(0);
  addTone(data, ctx.sampleRate, 1500, expDecay(8), 0.7);
  normalize(data, 0.8);
  return buffer;
}

/** A short descending two-tone "death sting" — own-death audio cue. */
function synthesizeDeathSting(ctx: BaseAudioContext): AudioBuffer {
  const buffer = createBuffer(ctx, 0.4);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(5000);
  fillNoise(data, rand, (t) => expDecay(12)(t) * 0.2);
  addTone(data, ctx.sampleRate, 320, expDecay(6), 0.5, 160);
  normalize(data, 0.7);
  return buffer;
}

export interface SoundBank {
  gunshot: Record<WeaponClass, AudioBuffer>;
  reloadClick: AudioBuffer;
  footstep: AudioBuffer[];
  ability: Record<AbilityCue, AudioBuffer>;
  uiClick: AudioBuffer;
  roundWinStinger: AudioBuffer;
  roundLoseStinger: AudioBuffer;
  hitConfirm: AudioBuffer;
  headshotDing: AudioBuffer;
  spikeBeep: AudioBuffer;
  deathSting: AudioBuffer;
}

/** Synthesizes every sound the game needs, once, at boot. */
export function buildSoundBank(ctx: BaseAudioContext): SoundBank {
  const classes: WeaponClass[] = ["pistol", "smg", "rifle", "sniper"];
  const gunshot = {} as Record<WeaponClass, AudioBuffer>;
  classes.forEach((cls, i) => {
    gunshot[cls] = synthesizeGunshot(ctx, cls, 1000 + i);
  });
  const abilityCues: AbilityCue[] = ["whoosh", "shimmer", "rumble", "crackle", "chime", "alarm"];
  const ability = {} as Record<AbilityCue, AudioBuffer>;
  abilityCues.forEach((cue, i) => {
    ability[cue] = synthesizeAbilityCue(ctx, cue, 2000 + i);
  });
  return {
    gunshot,
    reloadClick: synthesizeReloadClick(ctx, 3000),
    footstep: [synthesizeFootstep(ctx, 4000), synthesizeFootstep(ctx, 4001), synthesizeFootstep(ctx, 4002)],
    ability,
    uiClick: synthesizeUiClick(ctx),
    roundWinStinger: synthesizeRoundStinger(ctx, true),
    roundLoseStinger: synthesizeRoundStinger(ctx, false),
    hitConfirm: synthesizeHitConfirm(ctx, false),
    headshotDing: synthesizeHitConfirm(ctx, true),
    spikeBeep: synthesizeBeep(ctx),
    deathSting: synthesizeDeathSting(ctx),
  };
}

export { weaponClassFor };
export type { AbilityCue };
