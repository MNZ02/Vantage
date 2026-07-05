// M5 audio engine: AudioContext lifecycle, gain buses, and play3d()/play2d()
// built on Web Audio's PannerNode (HRTF panning). Browser-only (Web Audio
// isn't available headlessly) — never imported by a pure-logic unit test;
// the *decisions* this module leans on (occlusion, spike beep rate,
// footstep gating, volume clamping) all live in separately-tested pure
// modules (occlusion.ts, spikeBeep.ts, footsteps.ts, settings.ts).
//
// Gracefully degrades to a fully no-op engine if AudioContext isn't
// available at all (some headless/CI environments) — every method becomes a
// safe no-op rather than throwing, and resume() failures are always
// .catch()-ed so a missing user gesture never produces an unhandled
// rejection (spec acceptance criterion 8).
import { LEVEL_BOXES, type Vec3Like } from "@vg/sim";
import { computeOcclusion, OCCLUSION_GAIN_DB, OCCLUSION_LOWPASS_HZ } from "./occlusion.js";
import { spikeBeepIntervalMs } from "./spikeBeep.js";
import { buildSoundBank, type SoundBank } from "./synth.js";

export interface Play3DOptions {
  maxDistance?: number;
  gain?: number;
}

export interface SpikeBeepState {
  ticksLeft: number;
  totalTicks: number;
  pos: Vec3Like;
}

export interface AudioEngine {
  readonly sounds: SoundBank | null;
  /** Resumes the (autoplay-gated) AudioContext on the first pointer gesture on `target` — call once at boot with the canvas/pointer-lock element. */
  resumeOnGesture(target: EventTarget): void;
  setMasterVolume(v: number): void;
  setSfxVolume(v: number): void;
  setAnnouncerVolume(v: number): void;
  setMuteWhenTabHidden(enabled: boolean): void;
  /** Call once per rendered frame with the camera's world pose. */
  updateListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void;
  /** Positional playback via a PannerNode (HRTF), occlusion-checked once at emit time. */
  play3d(buffer: AudioBuffer | undefined, pos: Vec3Like, opts?: Play3DOptions): void;
  /** Non-positional playback straight to a bus — own gunshots/footsteps, UI clicks. */
  play2d(buffer: AudioBuffer | undefined, opts?: { gain?: number; bus?: "sfx" | "announcer" }): void;
  /** Starts (replacing any existing) the planted-spike's accelerating beep loop; occlusion is revalidated only every 500ms (spec) since the beep itself is short and frequent. `getState` returning null stops the loop. */
  startSpikeBeepLoop(getState: () => SpikeBeepState | null): void;
  stopSpikeBeepLoop(): void;
}

function hasWebAudio(): boolean {
  return typeof window !== "undefined" && (typeof window.AudioContext !== "undefined" || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined");
}

function noopEngine(): AudioEngine {
  return {
    sounds: null,
    resumeOnGesture() {},
    setMasterVolume() {},
    setSfxVolume() {},
    setAnnouncerVolume() {},
    setMuteWhenTabHidden() {},
    updateListener() {},
    play3d() {},
    play2d() {},
    startSpikeBeepLoop() {},
    stopSpikeBeepLoop() {},
  };
}

const SPIKE_BEEP_OCCLUSION_RECHECK_MS = 500;
const DEFAULT_MAX_DISTANCE = 30;

export function createAudioEngine(): AudioEngine {
  if (!hasWebAudio()) return noopEngine();

  let ctx: AudioContext;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  } catch {
    return noopEngine();
  }

  const masterGain = ctx.createGain();
  const sfxGain = ctx.createGain();
  const announcerGain = ctx.createGain();
  sfxGain.connect(masterGain);
  announcerGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  let masterVolume = 1;
  let muteWhenTabHiddenEnabled = true;
  let tabHidden = false;

  function applyMasterGain(): void {
    masterGain.gain.value = tabHidden && muteWhenTabHiddenEnabled ? 0 : masterVolume;
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      tabHidden = document.hidden;
      applyMasterGain();
    });
  }

  let sounds: SoundBank | null = null;
  try {
    sounds = buildSoundBank(ctx);
  } catch {
    sounds = null; // synthesis failure (extremely unlikely) — engine still runs, just silently plays nothing
  }

  let lastListenerPos: Vec3Like = { x: 0, y: 0, z: 0 };

  function setPannerPosition(panner: PannerNode, pos: Vec3Like): void {
    if (panner.positionX) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  function playInternal(buffer: AudioBuffer, opts: { pos?: Vec3Like; occluded?: boolean; gain: number; bus: GainNode; maxDistance?: number }): void {
    if (ctx.state !== "running") return; // no user gesture yet — silently skip, never queue/throw
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = opts.gain;

    let head: AudioNode = source;
    if (opts.pos) {
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "linear";
      panner.maxDistance = opts.maxDistance ?? DEFAULT_MAX_DISTANCE;
      panner.refDistance = 1;
      panner.rolloffFactor = 1;
      setPannerPosition(panner, opts.pos);
      source.connect(panner);
      head = panner;
    }

    if (opts.occluded) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = OCCLUSION_LOWPASS_HZ;
      gainNode.gain.value *= Math.pow(10, OCCLUSION_GAIN_DB / 20);
      head.connect(lowpass);
      head = lowpass;
    }

    head.connect(gainNode);
    gainNode.connect(opts.bus);
    source.start();
  }

  let spikeBeepTimer: ReturnType<typeof setTimeout> | null = null;
  function stopSpikeBeepLoop(): void {
    if (spikeBeepTimer) {
      clearTimeout(spikeBeepTimer);
      spikeBeepTimer = null;
    }
  }

  return {
    sounds,
    resumeOnGesture(target: EventTarget) {
      let done = false;
      const onGesture = (): void => {
        if (done) return;
        done = true;
        ctx.resume().catch(() => {
          /* resume can reject (context closed, etc.) — non-fatal, just try again on a later gesture */
          done = false;
        });
        target.removeEventListener("pointerdown", onGesture);
      };
      target.addEventListener("pointerdown", onGesture);
    },
    setMasterVolume(v: number) {
      masterVolume = Math.max(0, Math.min(1, v));
      applyMasterGain();
    },
    setSfxVolume(v: number) {
      sfxGain.gain.value = Math.max(0, Math.min(1, v));
    },
    setAnnouncerVolume(v: number) {
      announcerGain.gain.value = Math.max(0, Math.min(1, v));
    },
    setMuteWhenTabHidden(enabled: boolean) {
      muteWhenTabHiddenEnabled = enabled;
      applyMasterGain();
    },
    updateListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like) {
      lastListenerPos = pos;
      const listener = ctx.listener;
      if (listener.positionX) {
        listener.positionX.value = pos.x;
        listener.positionY.value = pos.y;
        listener.positionZ.value = pos.z;
        listener.forwardX.value = forward.x;
        listener.forwardY.value = forward.y;
        listener.forwardZ.value = forward.z;
        listener.upX.value = up.x;
        listener.upY.value = up.y;
        listener.upZ.value = up.z;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        listener.setPosition(pos.x, pos.y, pos.z);
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    },
    play3d(buffer: AudioBuffer | undefined, pos: Vec3Like, opts: Play3DOptions = {}) {
      if (!buffer) return;
      const occluded = computeOcclusion(LEVEL_BOXES, lastListenerPos, pos).occluded;
      playInternal(buffer, { pos, occluded, gain: opts.gain ?? 1, bus: sfxGain, maxDistance: opts.maxDistance });
    },
    play2d(buffer: AudioBuffer | undefined, opts: { gain?: number; bus?: "sfx" | "announcer" } = {}) {
      if (!buffer) return;
      const bus = opts.bus === "announcer" ? announcerGain : sfxGain;
      playInternal(buffer, { gain: opts.gain ?? 1, bus });
    },
    startSpikeBeepLoop(getState: () => SpikeBeepState | null) {
      stopSpikeBeepLoop();
      let lastOcclusionCheckMs = -Infinity;
      let occluded = false;
      const tick = (): void => {
        const state = getState();
        if (!state) {
          spikeBeepTimer = null;
          return;
        }
        const now = performance.now();
        if (now - lastOcclusionCheckMs >= SPIKE_BEEP_OCCLUSION_RECHECK_MS) {
          occluded = computeOcclusion(LEVEL_BOXES, lastListenerPos, state.pos).occluded;
          lastOcclusionCheckMs = now;
        }
        if (sounds) playInternal(sounds.spikeBeep, { pos: state.pos, occluded, gain: 1, bus: sfxGain, maxDistance: 40 });
        const interval = spikeBeepIntervalMs(state.ticksLeft, state.totalTicks);
        spikeBeepTimer = setTimeout(tick, interval);
      };
      tick();
    },
    stopSpikeBeepLoop,
  };
}
