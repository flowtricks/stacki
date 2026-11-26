// Suggestions in the editor. Two sources share one answer per place: the project's suggestions, and the grammar's own
// (HTML tags, CSS properties, JavaScript keywords), which stay out where the project's answer is the whole story, as it
// is wherever TypeScript knows what may be written.
import {
  autocompletion,
  completeFromList,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CodeCompletion, CodeCompletions, CodeEdit, CompletionKind } from '../../../shared/ipc/codeIntel';
import type { CodeIntelSession } from './codeIntelSession';
import { codeElement, describedElement, type TooltipCodeLanguage } from './codeIntelText';

export interface CompletionWords {
  /** What the mark beside a required property is called. */
  readonly required: () => string;
}

/** What each offered completion was made from, for drawing what CodeMirror's own row does not. */
const offeredItems = new WeakMap<Completion, CodeCompletion>();

/** What a completion source or an option renderer answers, "nothing" included. */
type Answer = Awaited<ReturnType<CompletionSource>>;

const VALID_WHILE = /^[\w$-]*$/;
const BOOST_LIMIT = 99;

export function codeIntelCompletion(session: CodeIntelSession, words: CompletionWords): Extension {
  const answers = new WeakMap<CompletionContext['state'], Map<number, Promise<CodeCompletions | undefined>>>();
  const asked = (context: CompletionContext): Promise<CodeCompletions | undefined> => {
    let places = answers.get(context.state);
    if (places === undefined) {
      places = new Map();
      answers.set(context.state, places);
    }
    let answer = places.get(context.pos);
    if (answer === undefined) {
      const text = context.state.doc.toString();
      answer = session
        .ask(text, { kind: 'complete', position: context.pos, explicit: context.explicit })
        .then((reply) => (reply.kind === 'completions' ? reply.completions : undefined));
      places.set(context.pos, answer);
    }
    return answer;
  };
  // Waited for however long it takes: CodeMirror shows the other source's suggestions meanwhile, and this answer joins
  // them when it comes, so what is typed before the project has been read still gets its suggestions.
  const project: CompletionSource = async (context) => {
    const text = context.state.doc.toString();
    const found = await asked(context);
    if (context.aborted || found === undefined || found.items.length === 0) {
      return nothing();
    }
    return {
      from: found.from,
      ...(found.to > context.pos ? { to: found.to } : {}),
      options: found.items.map((item) => option(session, item, { text, position: context.pos })),
      ...(found.incomplete ? {} : { validFor: VALID_WHILE }),
    };
  };
  const grammar: CompletionSource = async (context) => {
    if (session.ready()) {
      const found = await asked(context);
      if (found?.exclusive === true) {
        return nothing();
      }
    }
    return grammarCompletions(context);
  };
  return autocompletion({
    override: [project, grammar],
    icons: false,
    tooltipClass: () => 'code-intel-completions',
    addToOptions: [
      { position: 20, render: (completion) => swatch(completion) },
      { position: 60, render: (completion) => requiredMark(completion, words) },
      { position: 70, render: (completion) => detail(completion) },
    ],
  });
}

// A completion source says "nothing here" with null.
function nothing(): Answer {
  // eslint-disable-next-line stacki/no-null -- CodeMirror's CompletionSource answers null for no suggestions.
  return null;
}

// What the editor would have offered on its own: the sources the language at the cursor declares.
async function grammarCompletions(context: CompletionContext): Promise<Answer> {
  const sources = context.state.languageDataAt<CompletionSource | readonly (string | Completion)[]>('autocomplete', context.pos);
  let first: CompletionResult | undefined;
  const options: Completion[] = [];
  for (const source of sources) {
    const complete = typeof source === 'function' ? source : completeFromList(source);
    const result = await complete(context);
    if (!result) {
      continue;
    }
    first ??= result;
    if (result.from === first.from) {
      options.push(...result.options);
    }
  }
  return first === undefined ? nothing() : { ...first, options };
}

interface Question {
  readonly text: string;
  readonly position: number;
}

function option(session: CodeIntelSession, item: CodeCompletion, question: Question): Completion {
  const completion: Completion = {
    label: item.label,
    type: item.kind,
    boost: Math.max(-BOOST_LIMIT, Math.min(BOOST_LIMIT, item.boost)),
    info: async () => {
      let { signature, documentation } = item;
      if (item.entry !== undefined) {
        const reply = await session.ask(question.text, { kind: 'resolve', position: question.position, entry: item.entry });
        if (reply.kind === 'detail') {
          signature = reply.detail.signature;
          documentation = reply.detail.documentation;
        }
      }
      const element = describedElement(signature, documentation);
      // eslint-disable-next-line stacki/no-null -- CodeMirror's info panel answers null for nothing to show.
      return element ?? null;
    },
    apply: (view, completion, from, to) => {
      accept(view, completion, { item, from, to });
      // An export not yet imported brings its import once the type checker has said where it goes.
      if (item.entry?.source !== undefined) {
        void importEntry(view, session, { item, question });
      }
    },
  };
  offeredItems.set(completion, item);
  return completion;
}

interface Accepted {
  readonly item: CodeCompletion;
  readonly from: number;
  readonly to: number;
}

function accept(view: EditorView, completion: Completion, { item, from, to }: Accepted): void {
  const insert = item.insert ?? item.label;
  // Edits elsewhere were made for the text that was asked about; typing since only grew the word being completed, so
  // those that end before it still fit.
  const edits = item.edits.filter((edit) => edit.to <= from);
  const changes = view.state.changes([...edits, { from, to, insert }]);
  const start = changes.mapPos(from, -1);
  view.dispatch({
    changes,
    selection: { anchor: start + Math.min(insert.length, item.cursor ?? insert.length) },
    annotations: pickedCompletion.of(completion),
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  // Inside the quotes or braces just written, or in the folder just named, the next suggestions are wanted at once.
  if (item.cursor !== undefined || item.kind === 'folder') {
    startCompletion(view);
  }
}

async function importEntry(
  view: EditorView,
  session: CodeIntelSession,
  { item, question }: { readonly item: CodeCompletion; readonly question: Question },
): Promise<void> {
  if (item.entry === undefined) {
    return;
  }
  const reply = await session.ask(question.text, { kind: 'resolve', position: question.position, entry: item.entry });
  if (reply.kind !== 'detail' || reply.detail.edits.length === 0 || !view.dom.isConnected) {
    return;
  }
  const edits = reply.detail.edits.filter((edit) => unchangedThrough(view, question.text, edit));
  if (edits.length === reply.detail.edits.length) {
    view.dispatch({ changes: edits, userEvent: 'input.complete' });
  }
}

// An edit fits when nothing up to its end has changed since the question was asked.
function unchangedThrough(view: EditorView, asked: string, edit: CodeEdit): boolean {
  return edit.to <= view.state.doc.length && view.state.sliceDoc(0, edit.to) === asked.slice(0, edit.to);
}

// CodeMirror's option renderer says "nothing to draw" with null.
function nothingDrawn() {
  // eslint-disable-next-line stacki/no-null -- CodeMirror's option renderer answers null for nothing to draw.
  return null;
}

function swatch(completion: Completion): Element | ReturnType<typeof nothingDrawn> {
  const color = offeredItems.get(completion)?.color;
  if (color === undefined) {
    return nothingDrawn();
  }
  const element = document.createElement('span');
  element.className = 'code-intel-swatch';
  // The value comes from the project's own stylesheet; the browser drops what is not a colour.
  element.style.backgroundColor = color;
  return element;
}

function requiredMark(completion: Completion, words: CompletionWords): Element | ReturnType<typeof nothingDrawn> {
  if (offeredItems.get(completion)?.required !== true) {
    return nothingDrawn();
  }
  const element = document.createElement('span');
  element.className = 'code-intel-required';
  element.textContent = '*';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', words.required());
  return element;
}

const DETAIL_LANGUAGE: Partial<Record<CompletionKind, TooltipCodeLanguage>> = { property: 'typescript', cssVariable: 'css', variable: 'css' };

// Beside a label: a type or a value, coloured as code, then where it comes from as a name.
function detail(completion: Completion): Element | ReturnType<typeof nothingDrawn> {
  const item = offeredItems.get(completion);
  if (item?.detail === undefined) {
    return nothingDrawn();
  }
  const element = document.createElement('span');
  element.className = 'code-intel-aside';
  const language = DETAIL_LANGUAGE[item.kind];
  const [code, from] = language === undefined ? [undefined, item.detail] : item.detail.split('  ·  ');
  if (code !== undefined && language !== undefined) {
    element.append(codeElement(code, language, 'span'));
  }
  if (from !== undefined) {
    const name = document.createElement('bdi');
    name.className = 'code-intel-source';
    name.dir = 'ltr';
    name.textContent = from;
    element.append(name);
  }
  return element;
}
