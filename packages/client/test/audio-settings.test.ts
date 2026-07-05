import { describe, expect, it } from "vitest";
import { DEFAULT_VOLUME_SETTINGS, clamp01, loadVolumeSettings, saveVolumeSettings, type StorageLike } from "../src/audio/settings.js";

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("volume settings persistence (M5 acceptance criterion 7)", () => {
  it("clamps to [0,1]", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });

  it("loading from empty storage returns defaults", () => {
    const storage = fakeStorage();
    expect(loadVolumeSettings(storage)).toEqual(DEFAULT_VOLUME_SETTINGS);
  });

  it("round-trips saved settings", () => {
    const storage = fakeStorage();
    saveVolumeSettings(storage, { master: 0.6, sfx: 0.4, announcer: 0.9, muteWhenTabHidden: false });
    expect(loadVolumeSettings(storage)).toEqual({ master: 0.6, sfx: 0.4, announcer: 0.9, muteWhenTabHidden: false });
  });

  it("clamps out-of-range values on save", () => {
    const storage = fakeStorage();
    saveVolumeSettings(storage, { master: 2, sfx: -1, announcer: 0.5, muteWhenTabHidden: true });
    expect(loadVolumeSettings(storage)).toEqual({ master: 1, sfx: 0, announcer: 0.5, muteWhenTabHidden: true });
  });

  it("tolerates corrupt JSON in storage, falling back to defaults", () => {
    const storage = fakeStorage();
    storage.setItem("vg_audio_settings", "{not json");
    expect(loadVolumeSettings(storage)).toEqual(DEFAULT_VOLUME_SETTINGS);
  });

  it("tolerates a storage whose setItem throws (private-mode style quota errors)", () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => saveVolumeSettings(throwing, DEFAULT_VOLUME_SETTINGS)).not.toThrow();
  });
});
