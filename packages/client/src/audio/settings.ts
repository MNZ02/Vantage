// M5: volume settings persistence (master/sfx/announcer sliders + mute-on-
// tab-hidden), backed by a minimal storage interface (not the `localStorage`
// global directly) so this is unit-testable with an in-memory fake — main.ts
// wires the real `window.localStorage` in at the call site.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VolumeSettings {
  master: number;
  sfx: number;
  announcer: number;
  /** Default ON (spec): mutes all audio while the tab is hidden. */
  muteWhenTabHidden: boolean;
}

export const DEFAULT_VOLUME_SETTINGS: VolumeSettings = {
  master: 1,
  sfx: 1,
  announcer: 1,
  muteWhenTabHidden: true,
};

const STORAGE_KEY = "vg_audio_settings";

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Loads persisted settings, clamping every volume to [0,1] and falling back to defaults for missing/corrupt fields. */
export function loadVolumeSettings(storage: StorageLike): VolumeSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOLUME_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<VolumeSettings>;
    return {
      master: clamp01(typeof parsed.master === "number" ? parsed.master : DEFAULT_VOLUME_SETTINGS.master),
      sfx: clamp01(typeof parsed.sfx === "number" ? parsed.sfx : DEFAULT_VOLUME_SETTINGS.sfx),
      announcer: clamp01(typeof parsed.announcer === "number" ? parsed.announcer : DEFAULT_VOLUME_SETTINGS.announcer),
      muteWhenTabHidden: typeof parsed.muteWhenTabHidden === "boolean" ? parsed.muteWhenTabHidden : DEFAULT_VOLUME_SETTINGS.muteWhenTabHidden,
    };
  } catch {
    return { ...DEFAULT_VOLUME_SETTINGS };
  }
}

/** Persists `settings`, clamping every volume to [0,1] first. Swallows storage errors (private mode, quota, etc.) — non-fatal. */
export function saveVolumeSettings(storage: StorageLike, settings: VolumeSettings): void {
  try {
    const clamped: VolumeSettings = {
      master: clamp01(settings.master),
      sfx: clamp01(settings.sfx),
      announcer: clamp01(settings.announcer),
      muteWhenTabHidden: settings.muteWhenTabHidden,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    /* storage unavailable — non-fatal, settings just won't persist across reloads */
  }
}
