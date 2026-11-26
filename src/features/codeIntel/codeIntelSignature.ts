// Signature help: while the arguments of a call are being written, the call's signature stands above them with the
// argument at the cursor marked. It opens on `(` and `,`, follows the cursor, and closes with the call or on Escape.
import { keymap, showTooltip, ViewPlugin, type EditorView, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import type { CodeSignatureHelp } from '../../../shared/ipc/codeIntel';
import type { CodeIntelSession } from './codeIntelSession';
import { codeElement } from './codeIntelText';

const ASK_DELAY_MS = 120;

const shownHelp = StateEffect.define<CodeSignatureHelp | undefined>();

interface Shown {
  readonly help: CodeSignatureHelp | undefined;
  readonly tooltips: readonly Tooltip[];
}

const HIDDEN: Shown = { help: undefined, tooltips: [] };

const signatureField = StateField.define<Shown>({
  create: () => HIDDEN,
  update: (shown, transaction) => {
    const effect = transaction.effects.find((each) => each.is(shownHelp));
    if (effect === undefined) {
      return shown;
    }
    const help: CodeSignatureHelp | undefined = effect.value;
    if (help === undefined) {
      return HIDDEN;
    }
    return { help, tooltips: [signatureTooltip(help, Math.min(help.from, transaction.state.doc.length))] };
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field).tooltips),
});

function signatureTooltip(help: CodeSignatureHelp, position: number): Tooltip {
  return {
    pos: position,
    above: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'code-intel-hover code-intel-signature-help';
      const signature = help.signatures[help.active] ?? help.signatures[0];
      if (signature !== undefined) {
        const code = codeElement(signature.label, 'typescript', 'pre');
        markRange(code, signature.activeFrom, signature.activeTo);
        dom.append(code);
        if (signature.documentation !== undefined) {
          const prose = document.createElement('div');
          prose.className = 'code-intel-prose';
          prose.dir = 'auto';
          prose.textContent = signature.documentation;
          dom.append(prose);
        }
      }
      return { dom };
    },
  };
}

// The coloured tokens that make up the argument at the cursor are marked.
function markRange(code: HTMLElement, from: number, to: number): void {
  let offset = 0;
  for (const node of [...code.childNodes]) {
    const length = node.textContent?.length ?? 0;
    if (node instanceof HTMLElement && offset < to && offset + length > from) {
      node.classList.add('code-intel-argument');
    }
    offset += length;
  }
}

export function codeIntelSignature(session: CodeIntelSession): Extension {
  const follower = ViewPlugin.fromClass(
    class {
      private timer: number | undefined;
      private asked = 0;
      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        const showing = update.state.field(signatureField).help !== undefined;
        if (!update.docChanged && !(showing && update.selectionSet)) {
          return;
        }
        const typed = update.transactions.some((transaction) => transaction.isUserEvent('input'));
        const head = update.state.selection.main.head;
        const opens = typed && /[(,]\s*$/.test(update.state.sliceDoc(Math.max(0, head - 3), head));
        if (showing || opens) {
          this.askSoon();
        }
      }

      askSoon(): void {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.ask(), ASK_DELAY_MS);
      }

      async ask(): Promise<void> {
        const state = this.view.state;
        this.asked += 1;
        const asked = this.asked;
        const reply = await session.ask(state.doc.toString(), { kind: 'signature', position: state.selection.main.head });
        if (asked !== this.asked || this.view.state.doc !== state.doc || !this.view.dom.isConnected) {
          return;
        }
        const help = reply.kind === 'signature' ? reply.help : undefined;
        if (help !== undefined || this.view.state.field(signatureField).help !== undefined) {
          this.view.dispatch({ effects: shownHelp.of(help) });
        }
      }

      hide(): void {
        window.clearTimeout(this.timer);
        this.asked += 1;
      }

      destroy(): void {
        this.hide();
      }
    },
  );
  const close = (view: EditorView): boolean => {
    if (view.state.field(signatureField).help === undefined) {
      return false;
    }
    view.plugin(follower)?.hide();
    view.dispatch({ effects: shownHelp.of(undefined) });
    return true;
  };
  return [signatureField, follower, Prec.high(keymap.of([{ key: 'Escape', run: close }]))];
}
