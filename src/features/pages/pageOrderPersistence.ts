// A single in-flight save prevents reordered lists from overwriting each other's disk revision.
import { useEffect, useRef, useState } from 'react';
import { EMPTY_PAGE_ORDER, parsePageOrder, type PageOrder } from '../../../shared/properties/pageOrder';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';

export type PageOrderState =
  | { readonly kind: 'loading'; readonly order: PageOrder }
  | { readonly kind: 'ready'; readonly order: PageOrder; readonly source: string | undefined }
  | { readonly kind: 'saving'; readonly order: PageOrder }
  | { readonly kind: 'failed'; readonly order: PageOrder; readonly message: string };

export function useProjectPageOrder(project: string | undefined) {
  const [state, setState] = useState<PageOrderState>({ kind: 'loading', order: EMPTY_PAGE_ORDER });
  const controller = useRef<PageOrderController>();
  useEffect(() => {
    if (project === undefined) {
      setState({ kind: 'loading', order: EMPTY_PAGE_ORDER });
      return;
    }
    const current = new PageOrderController(project, setState);
    controller.current = current;
    const reload = () => current.reload();
    reload();
    window.addEventListener('focus', reload);
    window.addEventListener('stacki:pages-renamed', reload);
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener('stacki:pages-renamed', reload);
      current.close();
      controller.current = undefined;
    };
  }, [project]);
  return {
    state,
    save: (order: PageOrder) => controller.current?.save(order),
    reload: () => controller.current?.reload(),
  };
}

export class PageOrderController {
  private state: PageOrderState = { kind: 'loading', order: EMPTY_PAGE_ORDER };
  private closed = false;
  private request: object | undefined;
  constructor(
    private readonly project: string,
    private readonly notify: (state: PageOrderState) => void,
  ) {}

  reload(): void {
    if (this.closed || this.state.kind === 'saving') {
      return;
    }
    const token = {};
    this.request = token;
    this.report({ kind: 'loading', order: this.state.order });
    void readMetadata(this.project, 'pages')
      .then(({ source }) => {
        if (this.closed || this.request !== token) {
          return;
        }
        const input: unknown = source === undefined ? EMPTY_PAGE_ORDER : JSON.parse(source);
        this.report({ kind: 'ready', order: parsePageOrder(input), source });
      })
      .catch((error: unknown) => {
        if (!this.closed && this.request === token) {
          this.fail(error, this.state.order);
        }
      });
  }

  save(order: PageOrder): void {
    if (this.closed || this.state.kind !== 'ready') {
      return;
    }
    const previous = this.state;
    if (JSON.stringify(previous.order) === JSON.stringify(order)) {
      return;
    }
    this.report({ kind: 'saving', order });
    void writeMetadata(this.project, {
      kind: 'pages',
      source: JSON.stringify(order, undefined, 2) + '\n',
      ...(previous.source === undefined ? {} : { base: previous.source }),
    })
      .then(({ source }) => this.report({ kind: 'ready', order, source }))
      .catch((error: unknown) => this.fail(error, previous.order));
  }

  close(): void {
    // An already-started write finishes; its response cannot update an unmounted panel.
    this.closed = true;
  }

  private fail(error: unknown, order: PageOrder): void {
    const message = error instanceof Error ? error.message : 'Could not save page order.';
    this.report({ kind: 'failed', order, message });
  }

  private report(state: PageOrderState): void {
    if (!this.closed) {
      this.state = state;
      this.notify(state);
    }
  }
}
