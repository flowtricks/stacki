import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScanComponent } from '../../shared/scan';
import type { TrailingSlash } from '../appTypes';
import type { ComponentUsageFile } from '../paletteModel';
import type { ComponentCreationSource, UsageAnchor, UsagePopup } from './PaletteDialogs';
import { cleanError } from '../cleanError';
import { clearDrag, setDrag } from '../dragState';
import { rankInsertItems } from '../insertRank';
import {
  componentPreviewURL,
  groupPaletteComponents,
  parseComponentPreviewMessage,
  parseComponentUsage,
  prettyComponentName,
} from '../paletteModel';
import { ComponentPlusIcon, ElementComponentIcon, LayoutIcon } from '../ui/Icons';
import useDismiss from '../ui/useDismiss';
import { CreateComponentModal, InstancesPopup } from './PaletteDialogs';
import { currentDesktopPlatform, shortcutLabel } from '../shortcutLabel';

const TOOLTIP_DELAY_MS = 500;
const PREVIEW_DELAY_MS = 450;

interface PalettePanelProps {
  readonly components: readonly ScanComponent[];
  readonly devUrl: string | null;
  readonly trailingSlash: TrailingSlash;
  readonly onInsert: (name: string) => void;
  readonly onDragBegin?: () => void;
  readonly onCreateComponent: (name: string, options: { readonly withProps: boolean }) => void;
  readonly onUsage?: (component: ScanComponent) => Promise<unknown>;
  readonly onOpenUsage?: (file: ComponentUsageFile) => void;
  readonly pageInstances?: (name: string) => readonly { readonly id: string }[];
  readonly onSelectInstance?: (id: string) => void;
  readonly createFrom: ComponentCreationSource;
  readonly createRequest?: number;
}

interface Point {
  readonly left: number;
  readonly top: number;
}

export default function PalettePanel(props: PalettePanelProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const tooltip = useDelayedTooltip();
  const preview = useComponentPreview();
  const usage = useUsagePopup(props.onUsage, preview.cancel);
  const usageRef = useRef<HTMLDivElement>(null);
  useDismiss(usageRef, usage.value !== null, usage.close);
  useCreateRequest(props.createRequest ?? 0, props.createFrom, setCreating);
  const list = useMemo(() => rankInsertItems(props.components, query), [props.components, query]);
  const groups = useMemo(() => groupPaletteComponents(list), [list]);
  return (
    <div className="panel-section grow">
      <PaletteHeader source={props.createFrom} setCreating={setCreating} tooltip={tooltip} />
      <PaletteSearch query={query} setQuery={setQuery} />
      <PaletteList
        groups={groups}
        query={query}
        componentCount={props.components.length}
        onInsert={props.onInsert}
        {...(props.onDragBegin === undefined ? {} : { onDragBegin: props.onDragBegin })}
        preview={preview}
        openUsage={usage.open}
      />
      <PalettePopups
        props={props}
        creating={creating}
        setCreating={setCreating}
        usage={usage}
        usageRef={usageRef}
        preview={preview.value}
      />
    </div>
  );
}

function useCreateRequest(
  request: number,
  source: ComponentCreationSource,
  setCreating: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  const firstRequest = useRef(request);
  useEffect(() => {
    if (request === firstRequest.current) {
      return;
    }
    firstRequest.current = request;
    if (source.kind === 'ready') {
      setCreating(true);
    }
  }, [request, setCreating, source.kind]);
}

function useDelayedTooltip() {
  const [value, setValue] = useState<Point | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setValue({ left: rect.left + rect.width / 2, top: rect.bottom + 8 }),
      TOOLTIP_DELAY_MS,
    );
  }, []);
  const hide = useCallback((): void => {
    clearTimeout(timer.current);
    setValue(null);
  }, []);
  return { value, show, hide };
}

function useComponentPreview() {
  const [value, setValue] = useState<(Point & { readonly component: ScanComponent }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const schedule = useCallback((component: ScanComponent, anchor: HTMLElement): void => {
    clearTimeout(timer.current);
    const rect = anchor.getBoundingClientRect();
    const left = rect.right + 10;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 260));
    timer.current = setTimeout(
      () => setValue({ component, left, top }),
      PREVIEW_DELAY_MS,
    );
  }, []);
  const cancel = useCallback((): void => {
    clearTimeout(timer.current);
    setValue(null);
  }, []);
  return { value, schedule, cancel };
}

function useUsagePopup(onUsage: PalettePanelProps['onUsage'], cancelPreview: () => void) {
  const [value, setValue] = useState<UsagePopup | null>(null);
  const request = useRef(0);
  const close = useCallback((): void => {
    request.current += 1;
    setValue(null);
  }, []);
  const open = useCallback(
    async (component: ScanComponent, element: HTMLElement): Promise<void> => {
      cancelPreview();
      const token = request.current + 1;
      request.current = token;
      const anchor = usageAnchor(element);
      setValue({ kind: 'loading', name: component.name, anchor });
      let response: unknown;
      try {
        response = onUsage ? await onUsage(component) : { files: [] };
      } catch (error: unknown) {
        if (request.current === token) {
          setValue({ kind: 'error', name: component.name, anchor, message: cleanError(error) });
        }
        return;
      }
      const result = parseComponentUsage(response);
      if (request.current === token) {
        setValue(
          result.kind === 'error'
            ? { kind: 'error', name: component.name, anchor, message: result.message }
            : { kind: 'ready', name: component.name, anchor, files: result.files },
        );
      }
    },
    [cancelPreview, onUsage],
  );
  return { value, open, close };
}

function usageAnchor(element: HTMLElement): UsageAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

function PaletteHeader({
  source,
  setCreating,
  tooltip,
}: {
  readonly source: ComponentCreationSource;
  readonly setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  readonly tooltip: ReturnType<typeof useDelayedTooltip>;
}) {
  const canCreate = source.kind === 'ready';
  return (
    <>
      <div className="panel-header">
        <h2>Components</h2>
        <span className="tip-anchor" onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
          <button
            className="ghost"
            aria-label="New component"
            disabled={!canCreate}
            onClick={() => {
              tooltip.hide();
              setCreating(true);
            }}
          >
            <ComponentPlusIcon size={14} />
          </button>
        </span>
      </div>
      {tooltip.value && (
        <div className="rail-tooltip below" style={tooltip.value}>
          {canCreate
            ? `New component (${shortcutLabel('A', 'primary-shift', currentDesktopPlatform())})`
            : source.reason}
        </div>
      )}
    </>
  );
}

function PaletteSearch({
  query,
  setQuery,
}: {
  readonly query: string;
  readonly setQuery: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <div style={{ padding: '0 12px 8px' }}>
      <input
        value={query}
        placeholder="Search components"
        spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
    </div>
  );
}

interface PaletteListProps {
  readonly groups: readonly (readonly [string, readonly ScanComponent[]])[];
  readonly query: string;
  readonly componentCount: number;
  readonly onInsert: (name: string) => void;
  readonly onDragBegin?: () => void;
  readonly preview: ReturnType<typeof useComponentPreview>;
  readonly openUsage: (component: ScanComponent, anchor: HTMLElement) => Promise<void>;
}

function PaletteList(props: PaletteListProps) {
  const itemCount = props.groups.reduce((count, [, items]) => count + items.length, 0);
  return (
    <div className="panel-body" onMouseLeave={props.preview.cancel}>
      {props.groups.map(([folder, items]) => (
        <React.Fragment key={folder || '__root'}>
          {folder && <div className="palette-folder">{folder}</div>}
          {items.map((component) => (
            <PaletteItem key={component.path} component={component} props={props} />
          ))}
        </React.Fragment>
      ))}
      {itemCount === 0 && <PaletteEmpty count={props.componentCount} query={props.query} />}
    </div>
  );
}

function PaletteItem({
  component,
  props,
}: {
  readonly component: ScanComponent;
  readonly props: PaletteListProps;
}) {
  return (
    <div
      className="palette-item"
      draggable
      title="Drag into the Navigator, or double-click to add to the page"
      onMouseEnter={(event) => props.preview.schedule(component, event.currentTarget)}
      onMouseLeave={props.preview.cancel}
      onDragStart={(event) => startComponentDrag(event, component, props)}
      onDragEnd={clearDrag}
      onDoubleClick={() => props.onInsert(component.name)}
    >
      <span className="icon">
        {component.isLayout ? <LayoutIcon size={14} /> : <ElementComponentIcon size={14} />}
      </span>
      <span className="label">
        {prettyComponentName(component.name)}
        {component.instances !== undefined && (
          <div className="sub">
            <button
              type="button"
              className="palette-instances"
              disabled={component.instances === 0}
              onClick={(event) => {
                event.stopPropagation();
                void props.openUsage(component, event.currentTarget);
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onDragStart={(event) => event.preventDefault()}
            >
              {component.instances} instance{component.instances === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </span>
    </div>
  );
}

function startComponentDrag(
  event: React.DragEvent<HTMLDivElement>,
  component: ScanComponent,
  props: PaletteListProps,
): void {
  props.preview.cancel();
  event.dataTransfer.setData('avb/component', component.name);
  event.dataTransfer.effectAllowed = 'copy';
  setDrag({ kind: 'component', name: component.name });
  if (props.onDragBegin) {
    setTimeout(props.onDragBegin, 0);
  }
}

function PaletteEmpty({ count, query }: { readonly count: number; readonly query: string }) {
  return (
    <div className="props-empty">
      {count === 0 ? (
        <>
          No components found in <code>src/components</code>.
        </>
      ) : (
        <>No components match “{query.trim()}”.</>
      )}
    </div>
  );
}

function PalettePopups({
  props,
  creating,
  setCreating,
  usage,
  usageRef,
  preview,
}: {
  readonly props: PalettePanelProps;
  readonly creating: boolean;
  readonly setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  readonly usage: ReturnType<typeof useUsagePopup>;
  readonly usageRef: React.RefObject<HTMLDivElement>;
  readonly preview: ReturnType<typeof useComponentPreview>['value'];
}) {
  const source = props.createFrom;
  return (
    <>
      {creating && source.kind === 'ready' && (
        <CreateComponentModal
          source={source}
          taken={props.components.map((component) => component.name)}
          onClose={() => setCreating(false)}
          onCreate={(name, options) => {
            setCreating(false);
            props.onCreateComponent(name, options);
          }}
        />
      )}
      {usage.value && (
        <InstancesPopup
          popupRef={usageRef}
          usage={usage.value}
          here={props.pageInstances?.(usage.value.name) ?? []}
          onClose={usage.close}
          onOpen={(file) => {
            usage.close();
            props.onOpenUsage?.(file);
          }}
          onSelect={(id) => {
            usage.close();
            props.onSelectInstance?.(id);
          }}
        />
      )}
      {preview && props.devUrl && (
        <ComponentPreviewPopup
          key={preview.component.path}
          preview={preview}
          devURL={props.devUrl}
          trailingSlash={props.trailingSlash}
        />
      )}
    </>
  );
}

function ComponentPreviewPopup({
  preview,
  devURL,
  trailingSlash,
}: {
  readonly preview: NonNullable<ReturnType<typeof useComponentPreview>['value']>;
  readonly devURL: string;
  readonly trailingSlash: TrailingSlash;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const message = parseComponentPreviewMessage(event.data);
      if (message) {
        setReady(message.status === 'ready');
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return (
    <div
      className="comp-preview"
      style={{ left: preview.left, top: preview.top, visibility: ready ? 'visible' : 'hidden' }}
      aria-hidden={!ready}
    >
      <div className="comp-preview-title">{prettyComponentName(preview.component.name)}</div>
      <iframe
        ref={frameRef}
        src={componentPreviewURL(devURL, preview.component, trailingSlash)}
        title={`${preview.component.name} preview`}
      />
    </div>
  );
}
