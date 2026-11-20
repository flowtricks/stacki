// Questions for `npm create stacki`. Two implementations behind one interface: a terminal gets an
// arrow-key list, anything else (a script, a test, a pipe) gets a numbered list answered by lines.
// Both read only from the stream they are given and write only to the stream they are given.
import { createInterface, emitKeypressEvents, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface Choice {
  readonly label: string;
  readonly hint: string;
}

export interface Prompter {
  /** The index of the chosen entry. Enter takes `initial`. */
  select(question: string, choices: readonly Choice[], initial: number): Promise<number>;
  /** One line of text, trimmed. Enter answers with an empty string. */
  ask(question: string): Promise<string>;
  /** A line of feedback, such as why the last answer was refused. */
  say(line: string): void;
  close(): void;
}

const SELECT_ATTEMPTS_MAX = 5;

export function linePrompter(input: Readable, output: Writable): Prompter {
  const reader: Interface = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const next = async (): Promise<string> => {
    const line = await lines.next();
    if (line.done === true) {
      throw new Error('The answers ended before setup finished');
    }
    return String(line.value).trim();
  };
  return {
    async select(question, choices, initial) {
      output.write(`${question}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}) ${choice.label}  ${choice.hint}\n`));
      for (let attempt = 0; attempt < SELECT_ATTEMPTS_MAX; attempt += 1) {
        output.write(`Choose 1-${choices.length} [${initial + 1}]: `);
        const answer = await next();
        if (answer === '') {
          return initial;
        }
        const number = Number(answer);
        if (Number.isInteger(number) && number >= 1 && number <= choices.length) {
          return number - 1;
        }
      }
      throw new Error('No valid choice was given');
    },
    async ask(question) {
      output.write(question);
      return next();
    },
    say(line) {
      output.write(`${line}\n`);
    },
    close() {
      reader.close();
    },
  };
}

type RawInput = Readable & { readonly setRawMode: (enabled: boolean) => unknown };

export function isRawInput(input: Readable): input is RawInput {
  return 'setRawMode' in input && typeof input.setRawMode === 'function';
}

export function keyPrompter(input: RawInput, output: Writable): Prompter {
  return {
    select: (question, choices, initial) => selectWithKeys(input, output, question, choices, initial),
    ask: (question) => askLine(input, output, question),
    say(line) {
      output.write(`${line}\n`);
    },
    close() {
      input.pause();
    },
  };
}

function askLine(input: Readable, output: Writable, question: string): Promise<string> {
  const reader = createInterface({ input, output, terminal: true });
  return new Promise((resolve) => {
    reader.question(question, (answer) => {
      reader.close();
      resolve(answer.trim());
    });
  });
}

function selectWithKeys(input: RawInput, output: Writable, question: string, choices: readonly Choice[], initial: number): Promise<number> {
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let index = initial;
  const draw = (redraw: boolean) => {
    if (redraw) {
      output.write(`\x1b[${choices.length}A`);
    }
    choices.forEach((choice, position) => {
      const marker = position === index ? '❯' : ' ';
      output.write(`\x1b[2K${marker} ${choice.label}  \x1b[2m${choice.hint}\x1b[22m\n`);
    });
  };
  output.write(`${question}  \x1b[2m(arrow keys, Enter)\x1b[22m\n`);
  draw(false);
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      input.off('keypress', onKey);
      input.setRawMode(false);
      action();
    };
    const onKey = (_text: string | undefined, key: { readonly name?: string; readonly ctrl?: boolean } | undefined) => {
      if (key?.ctrl === true && key.name === 'c') {
        finish(() => reject(new Error('Cancelled. No files were changed.')));
      } else if (key?.name === 'up' || key?.name === 'k') {
        index = (index + choices.length - 1) % choices.length;
        draw(true);
      } else if (key?.name === 'down' || key?.name === 'j') {
        index = (index + 1) % choices.length;
        draw(true);
      } else if (key?.name === 'return') {
        finish(() => resolve(index));
      } else if (key?.name !== undefined && /^[1-9]$/.test(key.name) && Number(key.name) <= choices.length) {
        index = Number(key.name) - 1;
        draw(true);
      }
    };
    input.on('keypress', onKey);
  });
}
