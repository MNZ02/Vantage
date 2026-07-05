// M5 audio: round/spike/match announcer lines via the SpeechSynthesis API,
// with a graceful fallback to tone stingers when speech synthesis isn't
// available or has no voices loaded (some headless/CI browsers expose the
// API but report zero voices) — spec: "behind a feature check (if no
// speechSynthesis voices -> play stingers only)". Dependencies are injected
// so this is unit-testable with a mocked speechSynthesis present/absent,
// rather than reaching for the real `window.speechSynthesis` global.
export const ANNOUNCER_LINES = {
  roundStart: "Round start",
  spikePlanted: "Spike planted",
  lastPlayerStanding: "Last player standing",
  matchPoint: "Match point",
  attackersWin: "Attackers win",
  defendersWin: "Defenders win",
} as const;

export interface SpeechSynthesisLike {
  speak(utterance: unknown): void;
  getVoices(): readonly unknown[];
  cancel?(): void;
}

export interface AnnouncerDeps {
  /** Absent entirely (e.g. `window.speechSynthesis === undefined`) — some engines just don't implement the API. */
  speechSynthesis?: SpeechSynthesisLike;
  /** Constructs an utterance from a line of text; absent if `SpeechSynthesisUtterance` isn't defined either. */
  createUtterance?: (text: string) => unknown;
  /** Fallback: plays a synthesized tone stinger for a given line (see audio/synth.ts's stingers). */
  playStinger: (line: string) => void;
}

export interface Announcer {
  /** Speaks (or, on fallback, stings for) `line`. */
  speak(line: string): void;
  /** True iff this announcer is actually using SpeechSynthesis (false = stinger-only fallback). */
  usesSpeech(): boolean;
}

export function createAnnouncer(deps: AnnouncerDeps): Announcer {
  function hasWorkingSpeech(): boolean {
    return !!deps.speechSynthesis && !!deps.createUtterance && deps.speechSynthesis.getVoices().length > 0;
  }

  return {
    speak(line: string) {
      if (hasWorkingSpeech()) {
        const utterance = deps.createUtterance!(line);
        deps.speechSynthesis!.speak(utterance);
      } else {
        deps.playStinger(line);
      }
    },
    usesSpeech: hasWorkingSpeech,
  };
}
