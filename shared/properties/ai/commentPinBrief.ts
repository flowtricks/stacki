// What a "Send all" of comment pins carries to the agent (`ai:prompt`'s `pins`), what the transcript keeps of it,
// how a pin's agent asks the person a question, and the pure rules that decide which pins start together (docs/contracts.md, "Comment pins"). The
// board the pins are kept on is commentPins.ts; this file is the layer under it and under the chat model, so
// both can read it without importing each other.
import { assert } from '../../core/assert';
import { toArray, toRecord } from '../../core/record';
import { AI_LIMITS } from './aiLimits';
import { isProjectRelativePath, parseDraftSegments, plainTextOf, type ComposerSegments } from './mentions';

export const PIN_LIMITS = {
  /** Pins on one project's board, sent or not. Why: a page review rarely needs more, and the list stays a glance. */
  pinsMax: 40,
  /** A pin's comment: a long paragraph, far under a prompt's bound even with every pin of a send. */
  commentCharsMax: 4_000,
  /** Images one pin holds: the crop of what it points at and a few more. */
  imagesPerPinMax: 4,
  /** Base64 characters of all the board's images together: the bound of one composer draft's images. */
  boardImageCharsMax: AI_LIMITS.attachmentsImageCharsMax,
  /** Pins one send carries: each brings at least its crop, and a message holds `attachmentsMax` images. */
  pinsPerSendMax: AI_LIMITS.attachmentsMax,
  /** Subagents that run at once for one send. Why: each is a model session, and more than a few at once only queue at the provider. */
  concurrencyMax: 4,
  /** Names shown for a page or an element ("Home", "Heading “Welcome”"). */
  labelCharsMax: 120,
  /** A canvas path (`src/components/Card.astro|0.2`), the frame's own bound. */
  canvasPathCharsMax: 4_096,
  /** A tag or component name. */
  tagCharsMax: 120,
  /** The element's own words kept to find it again after the page changed. */
  textCharsMax: 80,
  /** Which copy of a repeated element: a loop renders at most this many. */
  occurrenceMax: 100_000,
  /** A canvas width in CSS pixels. */
  breakpointPxMax: 20_000,
  /** The highest pin number: numbers count up while the board has pins and start again at 1 when it is empty. */
  numberMax: 9_999,
  /** An image's name in a pin ("Pinned area"). */
  imageNameCharsMax: 200,
  /** A model's id or name, as the agent's model option gives them. */
  modelCharsMax: 200,
  /** A question a pin's agent asks the person, and each of the choices it offers. */
  questionCharsMax: 600,
  choicesMax: 6,
  choiceCharsMax: 160,
  /** Characters of one message read for questions (the newest ones: a report ends with its question). */
  questionScanCharsMax: 40_000,
  /** Questions read from one message: one for each pin a send can hold. */
  questionsPerTextMax: 16,
} as const satisfies Record<string, number>;

/**
 * The models Claude's Agent tool takes by name. Why: a pin of a one-message send runs in a subagent, and its call
 * names a model by one of these short names only, so no other entry of the panel's model list can be honoured there.
 */
export const SUBAGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export const PIN_SEND_MODES = ['subagents', 'single'] as const;
/**
 * How a send reaches the agent. `subagents`: one message for all the pins, the agent starting one subagent per
 * pin (Claude). `single`: one message per pin, sent one after another by Stacki (agents whose subagents the
 * panel cannot follow, Codex).
 */
export type PinSendMode = (typeof PIN_SEND_MODES)[number];

// ---------------------------------------------------------------------------
// The brief a send carries (`ai:prompt` part `pins`) and what the transcript keeps
// ---------------------------------------------------------------------------

/**
 * A pin's words with their `@` chips: `comment` is always their plain text (each chip as the reference the chat's
 * composer sends), and `segments` is kept only while there is a chip to draw. Older pins hold the text alone.
 */
export interface PinWords {
  readonly comment: string;
  readonly segments?: ComposerSegments;
}

/**
 * The chips of `comment` as stored or received, spread into what holds the words. Bounded as the chat's drafts are
 * (parseDraftSegments). Chips that do not parse, or whose plain text is not the comment, are left out and the words
 * stay as text: a pin is never lost, and the chips never say something the comment does not.
 */
export function pinSegmentsField(input: unknown, comment: string): { readonly segments?: ComposerSegments } {
  if (input === undefined) {
    return {};
  }
  const parsed = parseDraftSegments(input);
  if (!parsed.ok || !parsed.value.some((segment) => segment.kind === 'chip')) {
    return {};
  }
  return plainTextOf(parsed.value) === comment ? { segments: parsed.value } : {};
}

/** One pin as the agent is told about it. `images` are the indexes of its images among the message's attachments. */
export interface PinBriefEntry extends PinWords {
  readonly number: number;
  readonly pageLabel: string;
  readonly page: string;
  readonly elementLabel: string;
  readonly file: string;
  readonly locator: string;
  readonly tag: string;
  readonly text: string | undefined;
  readonly componentFile: string | undefined;
  readonly breakpointPx: number | undefined;
  readonly images: readonly number[];
  /** The model the person chose for this pin (a model option's value); absent runs it on the chat's model. */
  readonly model?: string;
  /** That model's name as the panel lists it, for the sent card. */
  readonly modelName?: string;
}

export interface PinBrief {
  readonly mode: PinSendMode;
  readonly pins: readonly PinBriefEntry[];
}

/** One pin as its sent message keeps it: enough to draw it, never the paths or the agent's instructions. */
export interface SentPin extends PinWords {
  readonly number: number;
  readonly pageLabel: string;
  readonly elementLabel: string;
  /** The index of its first image among the message's attachments, for the thumbnail. */
  readonly image: number | undefined;
  /** The model chosen for this pin, and its name; absent when it ran on the chat's model. */
  readonly model?: string;
  readonly modelName?: string;
}

/** A brief from the wire: bounded, numbers unique, a `single` brief holding exactly one pin, image indexes inside the message's attachments. */
export function parsePinBrief(input: unknown): PinBrief {
  const value = object(input, 'brief');
  const mode = oneOf(value['mode'], PIN_SEND_MODES, 'brief.mode');
  const pins = list(value['pins'], PIN_LIMITS.pinsPerSendMax, 'brief.pins').map(parseBriefEntry);
  if (pins.length === 0) {
    throw new Error('brief.pins: expected at least one pin');
  }
  if (mode === 'single' && pins.length !== 1) {
    throw new Error('brief.pins: a single send carries one pin');
  }
  if (new Set(pins.map((pin) => pin.number)).size !== pins.length) {
    throw new Error('brief.pins: repeated number');
  }
  if (mode === 'subagents' && !pins.every((pin) => pin.model === undefined || isSubagentModel(pin.model))) {
    throw new Error('brief.pins: a subagent cannot run that model');
  }
  const images = pins.flatMap((pin) => pin.images);
  if (new Set(images).size !== images.length) {
    throw new Error('brief.pins: an image belongs to one pin');
  }
  assert(
    images.every((index) => index < AI_LIMITS.attachmentsMax),
    'parsePinBrief: images index the attachments',
  );
  assert(pins.length <= PIN_LIMITS.pinsPerSendMax, 'parsePinBrief: a send is bounded');
  return { mode, pins };
}

function parseBriefEntry(input: unknown): PinBriefEntry {
  const value = object(input, 'brief.pin');
  const breakpoint = value['breakpointPx'];
  const comment = text(value['comment'], PIN_LIMITS.commentCharsMax, 'brief.pin.comment');
  return {
    number: pinNumber(value['number']),
    comment,
    ...pinSegmentsField(value['segments'], comment),
    pageLabel: nonEmpty(value['pageLabel'], PIN_LIMITS.labelCharsMax, 'brief.pin.pageLabel'),
    page: projectFile(value['page'], 'brief.pin.page'),
    elementLabel: nonEmpty(value['elementLabel'], PIN_LIMITS.labelCharsMax, 'brief.pin.elementLabel'),
    file: projectFile(value['file'], 'brief.pin.file'),
    locator: locator(value['locator']),
    tag: nonEmpty(value['tag'], PIN_LIMITS.tagCharsMax, 'brief.pin.tag'),
    text: value['text'] === undefined ? undefined : text(value['text'], PIN_LIMITS.textCharsMax, 'brief.pin.text'),
    componentFile: value['componentFile'] === undefined ? undefined : projectFile(value['componentFile'], 'brief.pin.componentFile'),
    breakpointPx: breakpoint === undefined ? undefined : positive(breakpoint, PIN_LIMITS.breakpointPxMax, 'brief.pin.breakpointPx'),
    images: list(value['images'], PIN_LIMITS.imagesPerPinMax, 'brief.pin.images').map((index) =>
      bounded(count(index, 'brief.pin.image'), AI_LIMITS.attachmentsMax - 1, 'brief.pin.image'),
    ),
    ...modelFields(value, 'brief.pin'),
  };
}

export function isSubagentModel(model: string): boolean {
  return SUBAGENT_MODELS.some((candidate) => candidate === model);
}

// The model chosen for a pin: both or neither, bounded; absent keys stay absent, so older messages read unchanged.
function modelFields(value: Record<string, unknown>, name: string): { readonly model?: string; readonly modelName?: string } {
  if (value['model'] === undefined) {
    return {};
  }
  return {
    model: nonEmpty(value['model'], PIN_LIMITS.modelCharsMax, `${name}.model`),
    modelName: nonEmpty(value['modelName'], PIN_LIMITS.modelCharsMax, `${name}.modelName`),
  };
}

/** What the transcript keeps of a brief: each pin's number, words and names, and where its thumbnail is. */
export function sentPinsOf(brief: PinBrief): readonly SentPin[] {
  const sent = brief.pins.map((pin) => ({
    number: pin.number,
    comment: pin.comment,
    ...(pin.segments === undefined ? {} : { segments: pin.segments }),
    pageLabel: pin.pageLabel,
    elementLabel: pin.elementLabel,
    image: pin.images[0],
    ...(pin.model === undefined || pin.modelName === undefined ? {} : { model: pin.model, modelName: pin.modelName }),
  }));
  assert(sent.length === brief.pins.length, 'sentPinsOf: one sent pin per pin');
  return sent;
}

export function parseSentPins(input: unknown): readonly SentPin[] {
  const pins = list(input, PIN_LIMITS.pinsPerSendMax, 'sentPins').map((entry) => {
    const value = object(entry, 'sentPin');
    const image = value['image'];
    const comment = text(value['comment'], PIN_LIMITS.commentCharsMax, 'sentPin.comment');
    return {
      number: pinNumber(value['number']),
      comment,
      ...pinSegmentsField(value['segments'], comment),
      pageLabel: nonEmpty(value['pageLabel'], PIN_LIMITS.labelCharsMax, 'sentPin.pageLabel'),
      elementLabel: nonEmpty(value['elementLabel'], PIN_LIMITS.labelCharsMax, 'sentPin.elementLabel'),
      image: image === undefined ? undefined : bounded(count(image, 'sentPin.image'), AI_LIMITS.attachmentsMax - 1, 'sentPin.image'),
      ...modelFields(value, 'sentPin'),
    };
  });
  if (pins.length === 0) {
    throw new Error('sentPins: expected at least one pin');
  }
  assert(pins.length <= PIN_LIMITS.pinsPerSendMax, 'parseSentPins: a send is bounded');
  return pins;
}

// ---------------------------------------------------------------------------
// Which pins start together
// ---------------------------------------------------------------------------

/**
 * The waves a `subagents` send runs in: every pin of a wave starts at once, at most `concurrencyMax` of them, in
 * number order; the rest wait for the next wave. Pins that change the same file run together too. Why that is
 * safe: all subagents of a send are one Claude Code process, whose edit tools replace an exact passage in the file
 * as it is at that moment and refuse a file that changed since the agent read it, so one pin's edit never
 * overwrites another's. The instructions (pinInstructions.ts) forbid the ways around that: rewriting a whole file
 * and writing files with shell commands.
 */
export function pinWaves(numbers: readonly number[], concurrencyMax: number = PIN_LIMITS.concurrencyMax): readonly (readonly number[])[] {
  assert(concurrencyMax >= 1, 'pinWaves: at least one pin runs at a time');
  assert(numbers.length <= PIN_LIMITS.pinsPerSendMax, 'pinWaves: a send is bounded');
  const ordered = [...numbers].sort((left, right) => left - right);
  const waves: number[][] = [];
  for (let from = 0; from < ordered.length; from += concurrencyMax) {
    waves.push(ordered.slice(from, from + concurrencyMax));
  }
  assert(waves.reduce((sum, wave) => sum + wave.length, 0) === numbers.length, 'pinWaves: every pin runs once');
  assert(
    waves.every((wave) => wave.length >= 1),
    'pinWaves: no wave is empty',
  );
  return waves;
}

// ---------------------------------------------------------------------------
// A pin's question to the person
// ---------------------------------------------------------------------------

/** A question a pin's agent asked, with the answers it offered (none: the person writes their own). */
export interface PinQuestion {
  readonly number: number;
  readonly question: string;
  readonly choices: readonly string[];
}

/** The words that open a pin's question, as the instructions ask for it. Plain words, so the message reads well as it is. */
export const PIN_QUESTION_LEAD = 'Question for pin'; // i18n-ignore: the form the agent is asked to write, matched.

const QUESTION_LINE = /^\s*(?:#{1,6}\s+)?(?:\*\*)?question for pin\s*#?(\d{1,4})(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/iu;
const CHOICE_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+)$/u;

/**
 * The questions a message asks about pins, in the order asked. Why a written form and not a question tool: Claude's
 * own question tool is off for a client that cannot draw ACP forms (Stacki declares no `elicitation`), and Codex
 * has none here, so a pin's agent can only ask in words. A line "Question for pin 2: …" asks; the list lines right
 * under it are the choices. Words without that line are not read as a question. Total and bounded: it reads the last
 * `questionScanCharsMax` characters and returns at most `questionsPerTextMax` questions.
 */
export function pinQuestionsOf(message: string): readonly PinQuestion[] {
  const lines = message.slice(-PIN_LIMITS.questionScanCharsMax).split('\n');
  const questions: PinQuestion[] = [];
  for (let index = 0; index < lines.length && questions.length < PIN_LIMITS.questionsPerTextMax; index += 1) {
    const match = QUESTION_LINE.exec(lines[index] ?? '');
    if (match === null) {
      continue;
    }
    const number = Number(match[1]);
    const question = questionWords(match[2] ?? '', PIN_LIMITS.questionCharsMax);
    if (number >= 1 && question !== '') {
      questions.push({ number, question, choices: choicesUnder(lines, index + 1) });
    }
  }
  assert(questions.length <= PIN_LIMITS.questionsPerTextMax, 'pinQuestionsOf: bounded');
  return questions;
}

// The list right under a question, with at most one blank line before it.
function choicesUnder(lines: readonly string[], from: number): readonly string[] {
  const choices: string[] = [];
  const start = (lines[from] ?? '').trim() === '' ? from + 1 : from;
  for (let index = start; index < lines.length && choices.length < PIN_LIMITS.choicesMax; index += 1) {
    const match = CHOICE_LINE.exec(lines[index] ?? '');
    const choice = match === null ? '' : questionWords(match[1] ?? '', PIN_LIMITS.choiceCharsMax);
    if (choice === '') {
      break;
    }
    if (!choices.includes(choice)) {
      choices.push(choice);
    }
  }
  assert(choices.length <= PIN_LIMITS.choicesMax, 'choicesUnder: bounded');
  return choices;
}

// Words as a button or a card shows them: Markdown's emphasis and code marks off, spaces folded, cut to the bound.
function questionWords(words: string, charsMax: number): string {
  const plain = words
    .replace(/\*\*|`/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return plain.length <= charsMax ? plain : `${plain.slice(0, charsMax - 1)}…`;
}

/** The note sent right before a pin's image, so the agent knows which pin it shows. */
/** Kept one line within the attachment note's bound (shared/ipc/aiChat.ts). */
export function pinImageNote(
  pin: Pick<PinBriefEntry, 'number' | 'breakpointPx'>,
  image: { readonly position: number; readonly kind: 'crop' | 'added' },
): string {
  assert(image.position >= 1, 'pinImageNote: images count from one');
  // i18n-ignore: words for the agent, never shown.
  const what = image.kind === 'crop' ? 'the pinned area as the canvas showed it' : 'an image the person added';
  const width = pin.breakpointPx === undefined ? '' : `, canvas ${pin.breakpointPx}px wide`;
  return `Pin ${pin.number}, image ${image.position}: ${what}${width}`; // i18n-ignore: words for the agent, never shown.
}

/** The pin number a subagent's title starts with ("Pin 3: Bigger heading"), as the brief asks the agent to title it. */
export function pinNumberOfTitle(title: string): number | undefined {
  const match = /^\s*\**\s*pin\s*#?\s*(\d{1,4})\b/iu.exec(title);
  if (match === null) {
    return undefined;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 1 && number <= PIN_LIMITS.numberMax ? number : undefined;
}

/**
 * A subagent's title as the panel shows it: without the "Pin 3:" the brief asks for (pinNumberOfTitle still reads it to
 * match the subagent to its pin). Why: the chat shows no pin numbers, so the number says nothing there. A title that is
 * only the number stays as it is.
 */
export function withoutPinNumber(title: string): string {
  const match = /^\s*\**\s*pin\s*#?\s*\d{1,4}\s*\**\s*[:.\-–—]\s*/iu.exec(title);
  if (match === null) {
    return title;
  }
  const rest = title.slice(match[0].length).trim();
  return rest === '' ? title : rest;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function pinNumber(input: unknown): number {
  const value = count(input, 'pin.number');
  if (value < 1 || value > PIN_LIMITS.numberMax) {
    throw new Error('pin.number: out of range');
  }
  return value;
}

function object(input: unknown, name: string): Record<string, unknown> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${name}: expected object`);
  }
  return value;
}

function list(input: unknown, max: number, name: string): readonly unknown[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error(`${name}: expected array`);
  }
  if (values.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return values;
}

function text(input: unknown, max: number, name: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${name}: expected string`);
  }
  if (input.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return input;
}

function nonEmpty(input: unknown, max: number, name: string): string {
  const value = text(input, max, name);
  if (value.trim().length === 0) {
    throw new Error(`${name}: expected non-empty text`);
  }
  return value;
}

function projectFile(input: unknown, name: string): string {
  const value = text(input, PIN_LIMITS.canvasPathCharsMax, name);
  if (!isProjectRelativePath(value)) {
    throw new Error(`${name}: expected a project-relative path`);
  }
  return value;
}

function locator(input: unknown): string {
  const value = text(input, PIN_LIMITS.canvasPathCharsMax, 'locator');
  if (!/^\d+(?:\.\d+)*$/u.test(value)) {
    throw new Error('locator: expected child indexes');
  }
  return value;
}

function count(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${name}: expected nonnegative integer`);
  }
  return input;
}

function bounded(value: number, max: number, name: string): number {
  if (value > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return value;
}

function positive(input: unknown, max: number, name: string): number {
  const value = bounded(count(input, name), max, name);
  if (value === 0) {
    throw new Error(`${name}: expected a positive width`);
  }
  return value;
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], name: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${name}: unknown value`);
  }
  return found;
}
