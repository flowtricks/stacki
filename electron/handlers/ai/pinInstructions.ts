// i18n-ignore-file: instructions written for the agent, never shown to the person.
// The words a "Send all" of comment pins gives the agent (docs/contracts.md, "Comment pins"). The person sees
// a clean message with their pins (the transcript keeps `SentPin`s only); the agent gets this text block, with
// every path, locator and breakpoint it needs, and the pins' images as the message's attachments.
//
// Two shapes, by the send's mode:
//   subagents  one message for all the pins. The agent starts one subagent per pin, titled "Pin <n>: …" so the
//              panel can match each subagent to its pin, in the waves `pinWaves` computed: pins that touch a
//              file in common never run at once, and at most `PIN_LIMITS.concurrencyMax` run together.
//   single     one pin per message (Stacki sends the next when this one's turn ends): the agent makes the
//              change itself.
// Pure: the host passes the brief, and a test reads the text.
import { assert } from '../../../shared/core/assert';
import { PIN_LIMITS, pinFiles, pinWaves, type PinBrief, type PinBriefEntry } from '../../../shared/properties/ai/commentPinBrief';

/** The text block for a brief, wrapped in a tag so the agent reads it as one set of instructions. */
export function pinInstructions(brief: PinBrief): string {
  assert(brief.pins.length >= 1, 'pinInstructions: a brief has a pin');
  assert(brief.pins.length <= PIN_LIMITS.pinsPerSendMax, 'pinInstructions: a brief is bounded');
  const body = brief.mode === 'subagents' ? subagentsText(brief.pins) : singleText(brief.pins);
  return `<comment-pins>\n${body}\n</comment-pins>`;
}

function subagentsText(pins: readonly PinBriefEntry[]): string {
  const waves = pinWaves(pins.map((pin) => ({ number: pin.number, files: pinFiles(pin) })));
  const waveLines = waves.map((wave, index) => `  Wave ${index + 1}: ${wave.map((number) => `pin ${number}`).join(', ')}`);
  const lines = [
    `The person pinned ${pins.length === 1 ? 'a comment' : `${pins.length} comments`} to their Astro site in Stacki, a visual editor. Each pin is one change they want, attached to one element of a page.`,
    '',
    'How to do this:',
    '- Start one subagent per pin with your Agent tool, and do not make the changes yourself.',
    '- Set each subagent\'s description to "Pin <number>: <three to six words>", for example "Pin 2: Bigger hero heading". Stacki matches that "Pin <number>" prefix to show the person how each pin is doing, so keep it exact.',
    '- Run the pins in these waves. Start every pin of a wave together (in one message), wait until all of them have finished, then start the next wave. Pins in different waves change a file in common, so they must never run at the same time.',
    ...waveLines,
    '- Give each subagent its pin below, word for word, and tell it which images are its own.',
    '- Tell every subagent: make small, targeted edits and never rewrite a whole file; read a file again right before changing it, since other pins may be editing the project at the same time; change only what its pin asks for.',
    '- Tell every subagent to end its report with one or two plain sentences a designer reads: what changed on the page, in words, without code, file paths or tags. The person sees that report.',
    '- Run every subagent in the foreground (never in the background), so each pin shows as finished only when its work is done.',
    '- If a pin needs a file another pin of the same wave also needs (a shared stylesheet, a layout), run that pin after the wave instead.',
    '- When every pin has finished, answer with one short line per pin, in plain words a designer reads: what changed, or why it could not be done.',
    '',
    ...pins.flatMap((pin) => [...pinLines(pin), '']),
  ];
  return lines.join('\n').trimEnd();
}

function singleText(pins: readonly PinBriefEntry[]): string {
  const pin = pins[0];
  assert(pin !== undefined, 'singleText: a single send holds its pin');
  assert(pins.length === 1, 'singleText: a single send holds one pin');
  const lines = [
    'The person pinned a comment to an element of their Astro site in Stacki, a visual editor. Make the change it asks for.',
    '- Make small, targeted edits and never rewrite a whole file; read a file again right before changing it.',
    '- Change only what this pin asks for.',
    '- When you are done, answer in one or two plain sentences a designer reads: what changed, or why it could not be done.',
    '',
    ...pinLines(pin),
  ];
  return lines.join('\n').trimEnd();
}

// One pin's brief: the comment in the person's words, then where it points, in names and in paths.
function pinLines(pin: PinBriefEntry): readonly string[] {
  const words = pin.text === undefined || pin.text.trim() === '' ? '' : `, with the text "${pin.text.trim()}"`;
  const width = pin.breakpointPx === undefined ? 'on the fluid canvas' : `with the canvas ${pin.breakpointPx}px wide (media queries for that width apply)`;
  const images = pin.images.length === 0 ? 'none' : `${pin.images.length}, each after a note that starts "Pin ${pin.number}, image"`;
  return [
    `Pin ${pin.number}`,
    `  Comment: ${pin.comment.trim() === '' ? '(no words: the images show what to change)' : indentComment(pin.comment)}`,
    `  Page: ${pin.pageLabel} (${pin.page}), pinned ${width}`,
    `  Element: ${pin.elementLabel}: <${pin.tag}>${words}, written in ${pin.file} at child path ${pin.locator} (the element's position among its parent's children at each level of the file's markup, counting from 0)`,
    ...(pin.componentFile === undefined ? [] : [`  Component: an instance of ${pin.componentFile}; the change may belong in that file`]),
    `  Images: ${images}`,
  ];
}

// A comment over several lines stays one field: each further line is indented under it.
function indentComment(comment: string): string {
  return comment.trim().split('\n').join('\n    ');
}
