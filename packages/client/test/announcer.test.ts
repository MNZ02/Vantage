import { describe, expect, it, vi } from "vitest";
import { ANNOUNCER_LINES, createAnnouncer } from "../src/audio/announcer.js";

describe("announcer feature-detect (M5 acceptance criterion 6)", () => {
  it("uses speechSynthesis when present with voices loaded", () => {
    const speak = vi.fn();
    const playStinger = vi.fn();
    const announcer = createAnnouncer({
      speechSynthesis: { speak, getVoices: () => [{ name: "Test Voice" }] },
      createUtterance: (text) => ({ text }),
      playStinger,
    });
    expect(announcer.usesSpeech()).toBe(true);
    announcer.speak(ANNOUNCER_LINES.roundStart);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(playStinger).not.toHaveBeenCalled();
  });

  it("falls back to a stinger when speechSynthesis is entirely absent", () => {
    const playStinger = vi.fn();
    const announcer = createAnnouncer({ speechSynthesis: undefined, createUtterance: undefined, playStinger });
    expect(announcer.usesSpeech()).toBe(false);
    announcer.speak(ANNOUNCER_LINES.spikePlanted);
    expect(playStinger).toHaveBeenCalledWith(ANNOUNCER_LINES.spikePlanted);
  });

  it("falls back to a stinger when speechSynthesis is present but reports zero voices", () => {
    const speak = vi.fn();
    const playStinger = vi.fn();
    const announcer = createAnnouncer({
      speechSynthesis: { speak, getVoices: () => [] },
      createUtterance: (text) => ({ text }),
      playStinger,
    });
    expect(announcer.usesSpeech()).toBe(false);
    announcer.speak(ANNOUNCER_LINES.attackersWin);
    expect(speak).not.toHaveBeenCalled();
    expect(playStinger).toHaveBeenCalledWith(ANNOUNCER_LINES.attackersWin);
  });
});
