// The bounds of voice input (AGENTS.md §10), kept beside the code that enforces them. Speech
// arrives one phrase at a time from the platform recognizer, so every number here caps either
// one phrase, one session or one list the phrase is matched against.

export const VOICE_LIMITS = {
  /** Characters of one recognized phrase; Chromium's own phrases are far shorter, so a longer one is a fault upstream. */
  utteranceCharsMax: 4_000,
  /** Words in one phrase after splitting on spaces. */
  utteranceWordsMax: 800,
  /** Words after a self-correction marker that count as its replacement (the clause being corrected is cut to the same length). */
  correctionWordsMax: 8,
  /** Entries in the dictionary a phrase is matched against: the project's names plus Stacki's own terms. */
  dictionaryEntriesMax: 600,
  /** Words in the spoken form of one dictionary entry. */
  dictionarySpokenWordsMax: 6,
  /** Characters of the written form of one dictionary entry. */
  dictionaryWrittenCharsMax: 120,
  /** Dictated pieces remembered so "delete that" can take the last one back. */
  historyMax: 32,
  /** How long the platform may take to say whether its on-device speech model is installed before the answer counts as no. */
  engineDetectMsMax: 2_000,
  /** Bars the waveform draws. */
  waveformBarsMax: 64,
  /** Presses at least this long are hold-to-talk: letting go stops; a shorter press latches hands-free. */
  holdMsMin: 350,
  /** Silence in hands-free after which listening stops by itself, so a forgotten microphone does not stay open. */
  silenceMsMax: 30_000,
  /** Times the recognizer may be started again inside one session (it ends itself after a pause). */
  restartsMax: 40,
  /** The longest session; the level meter and the recognizer both stop here. */
  sessionMsMax: 10 * 60 * 1000,
} as const satisfies Record<string, number>;
