// A single in-flight save prevents reordered lists from overwriting each other's disk revision.
import { useEffect, useRef, useState } from 'react';
import { EMPTY_PAGE_ORDER, parsePageOrder, type PageOrder } from '../../../shared/properties/pageOrder';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { createPanelCache } from '../../lib/usePanelData';
import { assert } from '../../../shared/core/assert';

export type PageOrderState =
  | { readonly kind: 'loading'; readonly order: PageOrder }
  | { readonly kind: 'ready'; readonly order: PageOrder; readonly source: string | undefined }
  | { readonly kind: 'saving'; readonly order: PageOrder }
  | { readonly kind: 'failed'; readonly order: PageOrder; readonly message: string };

// The order last read or saved per project. The Pages panel opens on it, then
// reads the file again: opening on the empty order drew the pages in their
// default order for a frame and then moved them, on every open of the panel.
const keptPageOrders = createPanelCache<KeptPageOrder>();

interface KeptPageOrder {
  readonly order: PageOrder;
  readonly source: string | undefined;
}

/** Reads the project's page order ahead of the Pages panel's first open (panelPrefetch.ts). */
export async function prewarmPageOrder(project: string): Promise<void> {
  assert(project.length > 0, 'prewarmPageOrder: a project is open');
  if (keptPageOrders.get(project) !== undefined) {
    return;
  }
  const { source } = await readMetadata(project, 'pages');
  const input: unknown = source === undefined ? EMPTY_PAGE_ORDER : JSON.parse(source);
  const order = parsePageOrder(input);
  // An order the panel read or saved meanwhile is newer than this one.
  if (keptPageOrders.get(project) === undefined) {
    keptPageOrders.set(project, { order, source });
  }
}

function initialPageOrder(project: string | undefined): PageOrderState {
  const kept = project === undefined ? undefined : keptPageOrders.get(project);
  if (kept?.kind === 'ready') {
    return { kind: 'ready', order: kept.value.order, source: kept.value.source };
  }
  return { kind: 'loading', order: EMPTY_PAGE_ORDER };
}

export function useProjectPageOrder(project: string | undefined) {
  const [state, setState] = useState<PageOrderState>(() => initialPageOrder(project));
  const controller = useRef<PageOrderController>();
  useEffect(() => {
    if (project === undefined) {
      setState({ kind: 'loading', order: EMPTY_PAGE_ORDER });
      return;
    }
    const current = new PageOrderController(project, initialPageOrder(project), setState);
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
  private state: PageOrderState;
  private closed = false;
  private request: object | undefined;
  constructor(
    private readonly project: string,
    initial: PageOrderState,
    private readonly notify: (state: PageOrderState) => void,
  ) {
    assert(initial.kind === 'loading' || initial.kind === 'ready', 'PageOrderController: it starts loading or on a kept order');
    this.state = initial;
  }

  reload(): void {
    if (this.closed || this.state.kind === 'saving') {
      return;
    }
    const token = {};
    this.request = token;
    // A kept order stays ready while it is read again, so the rows hold still and
    // a drag can start at once; a newer file replaces it when the read lands.
    if (this.state.kind !== 'ready') {
      this.report({ kind: 'loading', order: this.state.order });
    }
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
    // A read still in flight began before this write: its answer is older than the order saved here.
    this.request = undefined;
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
      if (state.kind === 'ready') {
        keptPageOrders.set(this.project, { order: state.order, source: state.source });
      }
      this.notify(state);
    }
  }
}
