# Voice dictation competitors (Wispr Flow and rivals)

Updated 2026-11

- **Cleanup beats raw accuracy.** Flow, Aqua, Willow, Monologue and Typeless win by removing fillers, resolving self-corrections ("5... actually 6") and punctuating, so the draft needs zero edits.
- **Context awareness wins.** Per-app tone or modes, a personal dictionary that learns, and reading on-screen names are the common thread of every leader.
- **Two camps.** Cloud and polished (Flow, Aqua, Willow) versus local, cheap, configurable (Superwhisper, VoiceInk, Spokenly, Handy). Privacy and one-time price are why people leave Flow.

Caveat: most comparison articles are vendor blogs or affiliate posts, and benchmarks are self-reported. Items marked "unverified" were not confirmed on a primary source.

## 1. Main table

| Product | Standout features | Why people use it | Weaknesses |
|---|---|---|---|
| **Wispr Flow** (Mac, Win, iOS, Android) | Filler/correction/repetition cleanup with visible labels; auto dictionary + shared team vocab; snippets; Formal/Casual/Very casual per app; Command Mode (experimental, Mac/Win); hands-free lock; 100+ languages auto-detect; "quiet as a whisper" | Most polished, widest platform reach (only major one on Android), largest free tier (2,000 words/week), most often named default pick; Flow claims #1 on Voice Arena dictation bench (79.4% ready-to-send) | Cloud only at every tier; $15/mo ($12 annual); privacy worries (default retention, context reading; one reviewer alleges keystroke logging, unverified); reports of high idle RAM, Windows freezes, dropped words, support delays; low Trustpilot score (about 2.5, small sample) |
| **Superwhisper** (Mac, Win, iOS, Android, Linux per its site) | Local Whisper/Parakeet offline; custom Modes with own prompts and per-mode model (GPT-5, Claude Haiku 4.5, Gemini, etc.); Super Mode reads screen; auto-activate modes per app; push-to-talk; bring your own API keys; meeting + file transcription | Control and value: free tier with unlimited local Whisper, Pro $8.49/mo, lifetime option; fully offline privacy; works with Cursor/Claude Code | Steepest setup, many knobs; speed depends on hardware; Windows/iOS reportedly trail Mac; Intel Macs weak offline; cleanup reportedly needs tuning |
| **Aqua Voice** (Mac, Win, iOS, Android) | Avalon model; Deep Context reads on-screen names; Edit Mode (select text, hold fn, say the change); Realtime mode (double-tap fn, live editable text, Max tier); voice commands (Max); custom instructions; personal dictionary; MCP/CLI/API | Technical vocabulary and code; rewrite-by-voice; claims #1 Voice Arena (80.5% zero-edit, vendor page); Privacy Mode, SOC 2 II, ISO 27001, HIPAA BAA | Cloud only; free tier is one-time 2,000 words (older sources say 1,000); best features on Max (about $24-30/mo); sources disagree on platforms and languages (unverified); one roundup rates it low |
| **Willow Voice** (Mac, Win, iPhone) | Text in "as little as 200 ms" (vendor); style memory; auto-learning dictionary; Shortcuts (snippets); Scribe drafts from rough notes; handles whispering and noise (vendor); offline mode on a paid plan | Fast, light, Flow-like polish; Voice Arena zero-edit 75.7% vs Claude 64.0% (Digg summary of a vendor post) | Offline claim disputed across sources (unverified); priced like Flow ($12-15/mo); one roundup scores it 4/10; Windows/Android availability inconsistent across sources |
| **Monologue** (Mac, iPhone, iPad, Watch) | 4 auto-switching modes (Chatting, Email, Notes, Coding) with custom instructions; mid-sentence language switching; local Mac models; dictionary; zero-retention AI providers; MCP/CLI/API for saved notes | Apple-only users wanting dictation plus notes plus bot-free meetings in one app; from the Every team | Apple only; $15/mo; free is a 1,000-word trial; formatting and sync need internet |
| **VoiceInk** (Apple Silicon Mac) | Open source (GPL v3); local models; AI enhancement removes fillers and rewrites selected text; dictionary; Smart Replace (snippets); per-app Power Mode (claimed by roundups, not on its page: unverified); Journal | One-time $25-49, no subscription, audio stays on device, code is auditable | Mac only; macOS 15+ per site; no translation (one roundup); solo-maintainer risk; cloud enhancement sends transcript to provider |
| **Spokenly** (Mac, Win, Linux, iOS, Android, Chrome) | Free unlimited local Whisper/Parakeet; Local Only Mode blocks network; bring your own API keys at no markup; local cleanup model; dictionary + word replacements; Agentic Actions; MCP voice input for Claude Code/Codex/Cursor; Quick Send (insert + Enter); MacBook tap shortcut | Best free entry; every platform; built for talking to coding agents | Pro is $12/mo annual ($15 monthly); more settings than Flow; Local+ is $39 one-time |
| **Handy** (Mac, Win, Linux) | MIT open source; local Whisper (Small to Large) and Parakeet V3; Silero voice-activity detection; hold-to-record and tap-to-toggle; transcription hook to rewrite before paste; CLI + Raycast | Free forever, fully local, only local option on Linux; about 39.5k GitHub stars | No AI cleanup/styles/dictionary UI documented (unverified beyond the hook); setup effort; community support only |
| **MacWhisper** (Mac) | Whisper transcription app that added dictation; one-time purchase | "Just works", low cost, a beginner pick in one roundup (author discloses Superwhisper partnership) | Few advanced features; I could not verify details on its own page |
| **Typeless** (Mac, Win, iOS, Android) | Strong cleanup; 8,000 free words/week (Voibe, a competitor, reports this) | Biggest free allowance, four platforms | No fully local mode; heavy cleanup can distort literal text |
| **Voibe** (Mac, Win) | Developer Mode; on-device on Apple Silicon | Cheap lifetime ($199) | Source is its own blog (not neutral); small |
| **Talon Voice** (Mac, Win, Linux) | Full hands-free control: grammars, navigation, code editing; free, extras via Patreon | Only real option for hands-free coding or RSI; deep customization | Weeks to months to learn; per-IDE setup; correction time about 15% falling to 8% in one author's test |
| **Dragon** (Win; Mac discontinued per general knowledge: unverified) | Long-standing dictation plus system control | Legacy/enterprise/medical habit | About $699; poor technical terms (one test: about 25% correction time); dated |
| **Apple Dictation** | Free, built in, on-device capable | Zero setup | No AI cleanup, weak dictionary, stops after about 30 s of silence, poor with self-corrections |
| **Windows Voice Access** | Free, built in on Win 11, voice control | Best free Windows option, accessibility | Less dictation-polished; not developer oriented |
| **Google voice typing** | Free in Docs, Android keyboard | Free browser option | Little evidence found beyond that; prose only |

## 2. Feature matrix

Y = documented, P = partial or paid tier or vendor claim only, N = not found, ? = unverified.

| Product | Latency claim | Filler/self-correct cleanup | Auto punctuation | Dictionary | Snippets | Per-app tone | Rewrite by voice | Hold-to-talk | Hands-free | Multilingual | Whisper-quiet | Offline | Voice edit/commands | Overlay/visual | Price (entry paid) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Wispr Flow | none measured | Y | Y | Y (auto) | Y | Y | P (Command Mode, experimental) | Y | Y | Y 100+ | Y | N | P | Y (Flow Bar) | $12-15/mo |
| Superwhisper | local depends on HW | P (modes) | Y | Y | ? | Y (auto modes) | Y (modes/prompts) | Y | ? | Y 100+ | N | Y | P | ? | $8.49/mo or $249.99 |
| Aqua Voice | none measured | Y | Y | Y (Pro) | ? | Y (context) | Y (Edit Mode) | Y (fn) | Y (Realtime, Max) | P | N | N | P (Max) | ? | about $8-10/mo |
| Willow | 200 ms (vendor) | Y | Y | Y | Y | Y | P (Scribe) | ? | ? | Y 100+ | Y (vendor) | P | ? | ? | $12-15/mo |
| Monologue | n/a | Y | Y | Y | ? | Y (modes) | N | ? | ? | Y | N | Y (Mac) | N | ? | $12-15/mo |
| VoiceInk | local | Y | Y | Y | Y | ? | Y (selected text) | ? | ? | Y | N | Y | N | ? | $25-49 once |
| Spokenly | local | Y | Y | Y | Y | Y (modes) | Y (AI Instructions) | Y | ? | Y 100+ | N | Y | Y (Agentic Actions) | Y (Notch/Capsule) | free; $39 once; $12/mo |
| Handy | local | N | Y (model output) | N | N | N | P (hook) | Y | Y (toggle) | Y (Parakeet auto) | N | Y | N | ? | free |
| Talon | n/a | N | P | Y | Y | N | N | Y | Y | N (English focus: unverified) | N | Y | Y (core) | ? | free |
| Dragon | n/a | N | Y | Y | Y | N | N | ? | ? | P | N | Y | Y | ? | about $699 |
| Apple Dictation | n/a | N | Y | N | N | N | N | Y | Y (30 s limit) | Y | N | Y | P | Y | free |

Numbers worth knowing:
- Superwhisper's own benchmark (vendor, 2026-09): its S1 Voice 6.6% WER at 26x speed; Wispr Flow raw (cleanup off) 8.7% WER at 5.1x. [Source](https://superwhisper.com/benchmarks)
- Voice Arena dictation bench: Flow says #1 with 79.4% ready-to-send and 0.40% characters to amend; Aqua says #1 with 80.5% vs Flow 79.3%. Two vendors, conflicting claims: unverified. [Flow](https://wisprflow.ai/research/voice-arena), [Aqua](https://aquavoice.com/)
- No independent latency measurements were found for any product.

## 3. What wins in a chat box (ranked)

Dictating into an AI chat input (Claude, ChatGPT, Cursor) is long, rambling, mid-thought prose that the model will read, not a human.

1. **Zero-edit first draft.** Fillers, false starts and "actually 6pm" corrections resolved so you can press Enter without fixing. This is the metric both Flow and Aqua advertise (zero-edit rate).
2. **Instant start and fast finish.** Hold-to-talk, text lands within about a second of release. Willow claims 200 ms; Aqua's Realtime shows text live. Latency sold by cloud tools is unmeasured: unverified.
3. **Technical vocabulary.** Dictionary that learns names, file paths, `useEffect`, product terms; Aqua's Deep Context reads on-screen names; Flow handles camelCase terms (reviewer claim).
4. **Hold-to-talk plus a hands-free lock.** Hold for short messages, double-tap or a toggle to latch for long ones (Flow: double-press within 500 ms; Aqua: double-tap fn; Handy: both modes).
5. **Visible recording state.** A small overlay or waveform that proves it is listening and where text will go (Flow Bar, Spokenly Notch/Capsule).
6. **Insert and send in one move.** Spokenly's Quick Send (insert then Enter) targets chat boxes directly.
7. **Auto punctuation and paragraphs.** Smart spacing and paragraph breaks so a long prompt is readable.
8. **Voice rewrite of what is already typed.** "Make this shorter" (Aqua Edit Mode, Flow Command Mode, VoiceInk selected-text rewrite).
9. **Per-app tone.** Matters less for chat boxes: the model does not care about tone. Casual mode is enough.
10. **Local or private processing.** Decisive for a minority; many dictate prompts containing code and company context. Offline: Superwhisper, VoiceInk, Spokenly, Handy, Monologue (Mac).
11. **Snippets, multilingual, whisper-quiet.** Nice, rarely the deciding factor for chat.

Gaps that are open for a built-in feature (inference from the above, not a sourced claim): one-key hold-to-talk inside the input itself, live visible transcript, cleanup that never changes meaning, and no permissions beyond the mic.

## 4. What Stacki built from this (Desktop AI composer)

| Winning feature | In Stacki | Runs |
|---|---|---|
| Hold-to-talk plus hands-free latch | One mic button: hold = push to talk, tap = latch, next tap stops (`voiceSession.ts`) | Local |
| Visible recording state, instant start | Waveform line on the first frame (skeleton until the mic opens), live level meter | Local (read-only analyser) |
| Live transcript | The phrase being spoken shows cleaned under the box | Recognizer: platform speech service |
| Zero-edit cleanup | Fillers, stutters, "no wait" corrections, spoken punctuation, capitals (`transcriptCleanup.ts`); English only | Local, rules (no model) |
| Technical vocabulary | Dictionary from the project's file names plus built-in code terms (`voiceDictionary.ts`) | Local |
| Voice commands, send in one move | "send", "new line", "new paragraph", "scratch that", "stop listening"; English only | Local |
| Language | Recognizer listens for the interface language; no auto-detect (the platform API has none) | Recognizer |
| Privacy | Note on the mic tooltip; Stacki never stores or relays audio | n/a |

Left out on purpose: LLM rewrite ("make this shorter"), per-app tone, auto-learning dictionary, offline model (each needs a new model or dependency), a global hotkey, a user-editable dictionary and snippets (needs settings storage).

## 5. Sources

Product sites
- Wispr Flow: https://wisprflow.ai
- Wispr Flow docs, Command Mode: https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode
- Wispr Flow docs, hands-free: https://docs.wisprflow.ai/articles/6391241694-Use-Flow-hands-free
- Wispr Flow Voice Arena post: https://wisprflow.ai/research/voice-arena
- Wispr Flow comparison page: https://wisprflow.ai/best-dictation-apps
- Superwhisper: https://superwhisper.com
- Superwhisper benchmarks: https://superwhisper.com/benchmarks
- Aqua Voice: https://aquavoice.com/
- Willow Voice: https://www.willowvoice.com
- Monologue: https://www.monologue.to
- VoiceInk: https://tryvoiceink.com
- Spokenly: https://spokenly.app
- Handy: https://github.com/cjpais/Handy

Comparisons and reviews (mostly vendor or affiliate, read with care)
- Voibe, Wispr Flow alternatives (includes Flow complaints): https://www.getvoibe.com/blog/wispr-flow-alternatives/
- This Week in AI Club guide (discloses Superwhisper partnership): https://thisweekinaiclub.substack.com/p/ultimate-guide-to-best-voice-dictation
- Digital Applied, Flow vs Superwhisper vs Aqua: https://www.digitalapplied.com/blog/ai-dictation-tools-2026-wispr-superwhisper-compared
- Zack Proser, voice coding tools (affiliate for Flow): https://zackproser.com/blog/voice-coding-tools-comparison-2026
- Roundup, best dictation apps for Mac: https://tryvoiceink.com/best-dictation-apps
- Roundup, Spokenly alternatives: https://www.getvoibe.com/resources/spokenly-alternatives/
- Talon and Dragon alternatives search results: https://lumevoice.com/blog/talon-voice-alternatives/
- Trustpilot, Wispr Flow: https://es.trustpilot.com/review/wisprflow.ai
- Wikipedia, Wispr Flow: https://en.wikipedia.org/wiki/Wispr_Flow
- Not reached: Reddit and Hacker News threads (searches returned none), voicearena.com leaderboard itself, Apple/Google/Microsoft/Talon/Dragon primary pages.
