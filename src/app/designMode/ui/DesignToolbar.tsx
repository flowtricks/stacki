// The floating tool bar at the bottom of the design canvas: Move (V), Text (T), Box (R), Image, Component,
// Hand (H), and the zoom.
import { useRef, useState } from 'react';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import TipAnchor from '../../../ui/TipAnchor';
import { INSTANCE_ATTRIBUTE } from '../model/designPrepare';
import { COMPONENT_ATTRIBUTE } from '../model/designDom';
import type { FrameId } from '../model/designTypes';
import { addInstance, designState, frameDocument, setTool, setView, useDesignState, type DesignTool } from '../runtime/designSession';
import { insertMarkup, selectionTargets } from '../runtime/designGestures';
import { addHeadStyles, componentMarkup } from '../runtime/designInstances';
import type { DesignWords } from '../i18n/designWords';
import type { DesignWordKey } from '../i18n/en';
import { useDesignActions } from './designActions';
import { fitView } from './canvasGeometry';
import { escapeHTML } from './designText';
import { BoxToolIcon, ComponentToolIcon, FitIcon, HandToolIcon, ImageToolIcon, MoveToolIcon, TextToolIcon } from './designIcons';

const IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const COMPONENTS_LISTED_MAX = 120;
const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;

const TOOLS: readonly {
  readonly tool: DesignTool;
  readonly label: DesignWordKey;
  readonly tip: DesignWordKey;
  readonly key: string;
  readonly icon: React.ReactNode;
}[] = [
  { tool: 'move', label: 'tool.move', tip: 'tool.moveTip', key: 'V', icon: <MoveToolIcon size={16} /> },
  { tool: 'text', label: 'tool.text', tip: 'tool.textTip', key: 'T', icon: <TextToolIcon size={16} /> },
  { tool: 'box', label: 'tool.box', tip: 'tool.boxTip', key: 'R', icon: <BoxToolIcon size={16} /> },
  { tool: 'hand', label: 'tool.hand', tip: 'tool.handTip', key: 'H', icon: <HandToolIcon size={16} /> },
];

/** Where an insertion from the tool bar goes: after the selection, else at the end of the page's main content. */
export function insertionPlace(): { readonly frame: FrameId; readonly parent: Element; readonly before: Node | undefined } | undefined {
  const state = designState();
  const targets = selectionTargets();
  const anchor = targets.at(-1);
  const frame = state.selection?.frame ?? state.frameSelected ?? state.frames[0]?.id;
  if (frame === undefined) {
    return undefined;
  }
  if (anchor !== undefined && anchor.parentElement !== null && anchor.tagName !== 'BODY') {
    return { frame, parent: anchor.parentElement, before: anchor.nextSibling ?? undefined };
  }
  const document = frameDocument(frame);
  const parent = document?.querySelector('main') ?? document?.body;
  return parent === null || parent === undefined ? undefined : { frame, parent, before: undefined };
}

let componentCounter = 0;

export function DesignToolbar({
  words,
  canvasSize,
}: {
  readonly words: DesignWords;
  readonly canvasSize: () => { readonly widthPx: number; readonly heightPx: number };
}) {
  const state = useDesignState();
  const actions = useDesignActions();
  const picker = useRef<HTMLInputElement>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const components = useMenuTrigger();
  const zoom = useMenuTrigger();
  const addComponent = async (path: string, name: string) => {
    const place = insertionPlace();
    if (place === undefined) {
      return;
    }
    const markup = await componentMarkup(path);
    if (!markup.ok) {
      actions.toast(words('toast.insertFailed', { detail: markup.detail === '' ? markup.reason : markup.detail.slice(0, 160) }), 'error');
      return;
    }
    const document = frameDocument(place.frame);
    if (document !== undefined) {
      addHeadStyles(document, markup.value.styles);
    }
    componentCounter += 1;
    const key = 'c' + componentCounter.toString(36);
    insertMarkup(place.frame, place.parent, place.before, markup.value.html, 'component', (tops) => {
      for (const top of tops) {
        top.setAttribute(INSTANCE_ATTRIBUTE, key);
        top.setAttribute(COMPONENT_ATTRIBUTE, path);
      }
    });
    addInstance(place.frame, key, { path: '', name, component: path, props: {}, codeProps: {}, line: undefined, slots: [] });
  };
  const componentEntries: MenuEntry[] =
    actions.components.length === 0
      ? [{ kind: 'note', id: 'none', text: words('tool.noComponents') }]
      : actions.components.slice(0, COMPONENTS_LISTED_MAX).map((component) => ({
          kind: 'item',
          id: component.path,
          label: component.name,
          description: component.path,
          icon: <ComponentToolIcon size={16} />,
          onSelect: () => void addComponent(component.path, component.name),
        }));
  const zoomEntries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'fit',
      label: words('zoom.fit'),
      shortcut: '⇧1',
      onSelect: () => {
        const size = canvasSize();
        setView(fitView(designState().frames, size.widthPx, size.heightPx));
      },
    },
    { kind: 'divider', id: 'd' },
    ...ZOOM_STEPS.map((step): MenuEntry => ({
      kind: 'item',
      id: 'z' + String(step),
      label: String(Math.round(step * 100)) + '%',
      checked: Math.abs(state.view.scale - step) < 0.001,
      onSelect: () => {
        const size = canvasSize();
        const view = designState().view;
        const ratio = step / view.scale;
        setView({
          xPx: size.widthPx / 2 - (size.widthPx / 2 - view.xPx) * ratio,
          yPx: size.heightPx / 2 - (size.heightPx / 2 - view.yPx) * ratio,
          scale: step,
        });
      },
    })),
  ];
  const onImage = (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (file.size > IMAGE_BYTES_MAX) {
      actions.toast(words('toast.imageTooLarge'), 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const place = insertionPlace();
      if (place === undefined || typeof reader.result !== 'string') {
        return;
      }
      insertMarkup(
        place.frame,
        place.parent,
        place.before,
        `<img src="${escapeHTML(reader.result)}" alt="" style="display:block;max-width:100%;height:auto">`,
        'image',
      );
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="dm-toolbar" role="toolbar" aria-label={words('mode.name')}>
      {TOOLS.map((entry) => (
        <TipAnchor key={entry.tool} text={`${words(entry.tip)} (${entry.key})`}>
          <button
            type="button"
            className={`dm-tool${state.tool === entry.tool ? ' is-active' : ''}`}
            aria-label={words(entry.label)}
            aria-pressed={state.tool === entry.tool}
            onClick={() => setTool(entry.tool)}
          >
            {entry.icon}
          </button>
        </TipAnchor>
      ))}
      <TipAnchor text={words('tool.imageTip')}>
        <button type="button" className="dm-tool" aria-label={words('tool.image')} onClick={() => picker.current?.click()}>
          <ImageToolIcon size={16} />
        </button>
      </TipAnchor>
      <TipAnchor text={words('tool.componentTip')}>
        <button
          type="button"
          ref={components.ref}
          className={`dm-tool${components.open ? ' is-active' : ''}`}
          aria-label={words('tool.component')}
          onClick={components.toggle}
        >
          <ComponentToolIcon size={16} />
        </button>
      </TipAnchor>
      <span className="dm-toolbar-divider" />
      <button type="button" ref={zoom.ref} className="dm-tool dm-zoom" aria-label={words('zoom.label')} onClick={zoom.toggle}>
        {String(Math.round(state.view.scale * 100))}%
      </button>
      <TipAnchor text={words('zoom.fit') + ' (⇧1)'}>
        <button
          type="button"
          className="dm-tool"
          aria-label={words('zoom.fit')}
          onClick={() => {
            const size = canvasSize();
            setView(fitView(state.frames, size.widthPx, size.heightPx));
          }}
        >
          <FitIcon size={16} />
        </button>
      </TipAnchor>
      <input
        ref={picker}
        key={pickerKey}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        hidden
        aria-label={words('tool.image')}
        onChange={(event) => {
          onImage(event.currentTarget.files?.[0]);
          // A new input for the next pick, so picking the same file again is heard as a change.
          setPickerKey((key) => key + 1);
        }}
      />
      <Menu
        open={components.open}
        anchor={components.anchor}
        entries={componentEntries}
        label={words('tool.component')}
        placement="above-start"
        widthPxMin={260}
        onClose={components.close}
      />
      <Menu
        open={zoom.open}
        anchor={zoom.anchor}
        entries={zoomEntries}
        label={words('zoom.label')}
        placement="above-end"
        widthPxMin={180}
        onClose={zoom.close}
      />
    </div>
  );
}
