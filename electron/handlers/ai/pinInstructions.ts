// i18n-ignore-file: instructions written for the agent, never shown to the person.
// The words a "Send all" of comment pins gives the agent (docs/contracts.md, "Comment pins"). The person sees
// a clean message with their pins (the transcript keeps `SentPin`s only); the agent gets this text block, with
// every path, locator and breakpoint it needs, and the pins' images as the message's attachments.
//
// Two shapes, by the send's mode:
//   subagents  one message for all the pins. The agent starts one subagent per pin, titled "Pin <n>: …" so the
//              panel can match each subagent to its pin, in the waves `pinWaves` computed: up to
//              `PIN_LIMITS.concurrencyMax` pins start together, shared files included (the edit rules below keep
//              their changes apart).
//   single     one pin per message (Stacki sends the next when this one's turn ends): the agent makes the
//              change itself.
// In both, a pin that cannot be done without the person's answer asks in the written form `pinQuestionsOf` reads.
// Pure: the host passes the brief, and a test reads the text.
import { assert } from '../../../shared/core/assert';
import { PIN_LIMITS, PIN_QUESTION_LEAD, pinWaves, type PinBrief, type PinBriefEntry } from '../../../shared/properties/ai/commentPinBrief';

/** The text block for a brief, wrapped in a tag so the agent reads it as one set of instructions. */
export function pinInstructions(brief: PinBrief): string {
  assert(brief.pins.length >= 1, 'pinInstructions: a brief has a pin');
  assert(brief.pins.length <= PIN_LIMITS.pinsPerSendMax, 'pinInstructions: a brief is bounded');
  const body = brief.mode === 'subagents' ? subagentsText(brief.pins) : singleText(brief.pins);
  return `<comment-pins>\n${body}\n</comment-pins>`;
}

// Rules that keep two pins' changes to one file apart.
const EDIT_RULES = [
  'make small, targeted edits with your edit tool and never rewrite a whole file or write over an existing one',
  'never change a file with a shell command (no sed, no redirects, no scripts that write files), and never run a command that rewrites files across the project (a formatter, git checkout, git restore, git stash)',
  'other pins may be editing the same files at this moment: read a file again right before changing it, and when an edit is refused because the file changed or its old text is gone, read it again and redo only your own change, never restoring older text',
];

function subagentsText(pins: readonly PinBriefEntry[]): string {
  const waves = pinWaves(pins.map((pin) => pin.number));
  const waveLines = waves.map((wave, index) => `  Wave ${index + 1}: ${wave.map((number) => `pin ${number}`).join(', ')}`);
  const waiting =
    waves.length === 1
      ? 'say in one short sentence that all the pins are running at the same time'
      : `say in one short sentence that the first ${PIN_LIMITS.concurrencyMax} pins are running at the same time and the rest are waiting`;
  const lines = [
    `The person pinned ${pins.length === 1 ? 'a comment' : `${pins.length} comments`} to their Astro site in Stacki, a visual editor. Each pin is one change they want, attached to one element of a page.`,
    '',
    'How to do this:',
    '- Start one subagent per pin with your Agent tool, and do not make the changes yourself.',
    '- Set each subagent\'s description to "Pin <number>: <three to six words>", for example "Pin 2: Bigger hero heading". Stacki matches that "Pin <number>" prefix to show the person how each pin is doing, so keep it exact. If you start a pin again later, use the same prefix.',
    '- Run the pins in these waves. Start every pin of a wave at the same time: all of its Agent calls in one single message. Wait until all of them have finished before starting the next wave.',
    ...waveLines,
    `- Do not run the pins of a wave one after another, even when they change the same file: the edit rules below keep their changes apart. The person asked for this. Before the first wave, ${waiting}.`,
    ...(pins.some((pin) => pin.model !== undefined)
      ? [
          '- The person chose a model for some pins. For a pin with a "Model:" line, set its Agent call\'s model parameter to exactly that value. For a pin without one, leave the model parameter out.',
        ]
      : []),
    '- Give each subagent its pin below, word for word, and tell it which images are its own.',
    `- Tell every subagent these edit rules: ${EDIT_RULES.join('; ')}; change only what its pin asks for.`,
    '- Tell every subagent to end its report with one or two plain sentences a designer reads: what changed on the page, in words, without code, file paths or tags. The person sees that report.',
    '- Set run_in_background to false on every Agent call, so each pin shows as finished only when its work is done.',
    ...questionRules(
      "Tell every subagent: it cannot ask the person anything itself. If it cannot do its pin without an answer, it must not guess: it ends its report with the question in the form below, and you repeat that question, in the same form, in your next message to the person. One pin's question never delays the other pins.",
    ),
    '- When every pin has finished, answer with one short line per pin, in plain words a designer reads: what changed, why it could not be done, or its question in the form below.',
    '',
    ...pins.flatMap((pin) => [...pinLines(pin), ...(pin.model === undefined ? [] : [`  Model: ${pin.model}`]), '']),
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
    ...questionRules('If you cannot make the change without an answer from the person, do not guess: end your answer with the question in the form below.'),
    '',
    ...pinLines(pin),
  ];
  return lines.join('\n').trimEnd();
}

// How a question reaches the person: Stacki reads this exact form and shows the choices as buttons beside the pin.
function questionRules(when: string): readonly string[] {
  return [
    `- ${when}`,
    '  The form, on lines of their own, with the first words kept exactly as written here (in English) so Stacki can show the question and its choices as buttons on the pin:',
    `  ${PIN_QUESTION_LEAD} <number>: <the question in one sentence, in the person's language>`,
    '  - <a short possible answer>',
    '  - <another short possible answer>',
    `  Offer two to four answers when there are natural ones; leave the list out when only the person's own words can answer. Never write a line starting "${PIN_QUESTION_LEAD}" unless you need that answer.`,
  ];
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
