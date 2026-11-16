import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { TrailingSlash } from '../../editor/pageState';
import type { ComponentUsageFile } from './paletteModel';
import type { ComponentCreationSource, UsageAnchor, UsagePopup } from './PaletteDialogs';
import { cleanError } from '../../lib/cleanError';
import { allowDragEffect, clearDrag, setDrag } from '../../editor/dragState';
import { rankInsertItems } from '../../lib/insertRank';
import { ComponentPreviewPopup } from './ComponentPreviewPopup';
import { useAddableComponents } from './componentVisibility';
import type { PaletteRoleRules } from './componentRolesMenu';
import { PaletteRowMenu } from './PaletteRowMenu';
import type { MenuEntry } from '../../ui/Menu';
import { rolesSubmenu } from './componentRolesMenu';
import { componentRuleFile } from '../../../shared/properties/componentAccess';
import { groupPaletteComponents, parseComponentUsage, prettyComponentName } from './paletteModel';
import { ElementComponentIcon, LayoutIcon, PlusIcon } from '../../ui/Icons';
import { CreateComponentModal, InstancesPopup } from './PaletteDialogs';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { useDelayedTooltip } from '../../ui/delayedTooltip';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { currentRole } from '../../lib/currentRole';
import { useTranslate, useTranslateDescribed, useTranslateRich } from '../../lib/i18n/useTranslate';

interface PalettePanelProps {
  readonly components: readonly ScanComponent[];
  /** The project's roles and how to change one's hidden components; the rows' "…" menu offers a Roles submenu with it. Absent: no menu. */
  readonly roleRules?: PaletteRoleRules | undefined;
  readonly devUrl: string | undefined;
  readonly resolvePreviewURL?: (url: string) => Promise<string>;
  readonly trailingSlash: TrailingSlash;
  readonly onInsert: (name: string) => void;
  readonly onDragBegin?: () => void;
  readonly onCreateComponent: (name: string, options: { readonly asProp: readonly string[] }) => void;
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
  useCreateRequest(props.createRequest ?? 0, props.createFrom, setCreating);
  // The list shows what this role may add; a new component's name is still checked against every component (PalettePopups).
  const addable = useAddableComponents(props.components);
  const list = useMemo(() => rankInsertItems(addable, query), [addable, query]);
  const groups = useMemo(() => groupPaletteComponents(list), [list]);
  return (
    <div className="panel-section grow">
      <PaletteHeader source={props.createFrom} setCreating={setCreating} tooltip={tooltip} />
      <PaletteSearch query={query} setQuery={setQuery} />
      <PaletteList
        groups={groups}
        query={query}
        componentCount={addable.length}
        roleRules={props.roleRules}
        allComponents={props.components}
        onInsert={props.onInsert}
        {...(props.onDragBegin === undefined ? {} : { onDragBegin: props.onDragBegin })}
        preview={preview}
        openUsage={usage.open}
      />
      <PalettePopups props={props} creating={creating} setCreating={setCreating} usage={usage} usageRef={usageRef} preview={preview.value} />
    </div>
  );
}

function useCreateRequest(request: number, source: ComponentCreationSource, setCreating: React.Dispatch<React.SetStateAction<boolean>>): void {
  const firstRequest = useRef(request);
  useEffect(() => {
    if (request === firstRequest.current) {
      return;
    }
    firstRequest.current = request;
    // The shortcut asks too: a role without component creation is not offered the dialog.
    if (source.kind === 'ready' && can(currentRole(), 'component:create')) {
      setCreating(true);
    }
  }, [request, setCreating, source.kind]);
}

function useComponentPreview() {
  const [value, setValue] = useState<(Point & { readonly component: ScanComponent }) | undefined>(undefined);
  // While a row's menu is open the hover card stays away: it is a fixed card at a higher layer than panel content, and a menu being
  // navigated, its submenu included, must never sit behind it.
  const blocked = useRef(false);
  const show = useCallback((component: ScanComponent, anchor: HTMLElement): void => {
    if (blocked.current) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const left = rect.right + 10;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 260));
    setValue({ component, left, top });
  }, []);
  const cancel = useCallback((): void => {
    setValue(undefined);
  }, []);
  const block = useCallback((menuOpen: boolean): void => {
    blocked.current = menuOpen;
    if (menuOpen) {
      setValue(undefined);
    }
  }, []);
  return { value, show, cancel, block };
}

function useUsagePopup(onUsage: PalettePanelProps['onUsage'], cancelPreview: () => void) {
  const [value, setValue] = useState<UsagePopup | undefined>(undefined);
  const request = useRef(0);
  const close = useCallback((): void => {
    request.current += 1;
    setValue(undefined);
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const canCreate = source.kind === 'ready';
  const allowed = can(useCurrentRole(), 'component:create');
  return (
    <>
      <div className="panel-header">
        <h2>{translate('palette.panel.title')}</h2>
        <span hidden={!allowed} className="tip-anchor" onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
          <button
            className="ghost"
            aria-label={translate('palette.panel.new')}
            disabled={!canCreate}
            onClick={() => {
              tooltip.hide();
              setCreating(true);
            }}
          >
            <PlusIcon size={14} />
          </button>
        </span>
      </div>
      {tooltip.value && (
        <div className="rail-tooltip below" style={tooltip.value}>
          {canCreate
            ? translate('palette.panel.newShortcut', { shortcut: shortcutLabel('A', 'primary-shift', currentDesktopPlatform()) })
            : translateDescribed({ message: source.reason, messageRef: source.reasonRef })}
        </div>
      )}
    </>
  );
}

function PaletteSearch({ query, setQuery }: { readonly query: string; readonly setQuery: React.Dispatch<React.SetStateAction<string>> }) {
  const translate = useTranslate();
  return (
    <div style={{ padding: '0 12px 8px' }}>
      <input value={query} placeholder={translate('palette.panel.search')} spellCheck={false} onChange={(event) => setQuery(event.currentTarget.value)} />
    </div>
  );
}

interface PaletteListProps {
  readonly groups: readonly (readonly [string, readonly ScanComponent[]])[];
  readonly query: string;
  readonly componentCount: number;
  readonly roleRules: PaletteRoleRules | undefined;
  /** Every component of the project, hidden ones too, for a folder's counts in the Roles submenu. */
  readonly allComponents: readonly ScanComponent[];
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
          {folder && (
            <div className="palette-folder">
              {folder}
              <FolderRoles folder={folder} props={props} />
            </div>
          )}
          {items.map((component) => (
            <PaletteItem key={component.path} component={component} props={props} />
          ))}
        </React.Fragment>
      ))}
      {itemCount === 0 && <PaletteEmpty count={props.componentCount} query={props.query} />}
    </div>
  );
}

function PaletteItem({ component, props }: { readonly component: ScanComponent; readonly props: PaletteListProps }) {
  const translate = useTranslate();
  return (
    <div
      className="palette-item"
      draggable
      title={translate('palette.panel.itemHint')}
      onMouseEnter={(event) => props.preview.show(component, event.currentTarget)}
      onDragStart={(event) => startComponentDrag(event, component, props)}
      onDragEnd={clearDrag}
      onDoubleClick={() => props.onInsert(component.path)}
    >
      <span className="icon">{component.isLayout ? <LayoutIcon size={14} /> : <ElementComponentIcon size={14} />}</span>
      <ItemRoles component={component} props={props} />
      <span className="label">
        {prettyComponentName(component.name)}
        <div className="sub">
          <button
            type="button"
            className="palette-instances"
            disabled={component.instances === undefined || component.instances === 0}
            onClick={(event) => {
              event.stopPropagation();
              void props.openUsage(component, event.currentTarget);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onDragStart={(event) => event.preventDefault()}
          >
            {component.instances === undefined ? (
              <span className="panel-loading-label">{translate('palette.panel.checking')}</span>
            ) : (
              translate('palette.panel.instances', { count: component.instances })
            )}
          </button>
        </div>
      </span>
    </div>
  );
}

// The "…" for one component: Show instances (what the instances count opens) and, when the project has roles, Roles.
function ItemRoles({ component, props }: { readonly component: ScanComponent; readonly props: PaletteListProps }) {
  const translate = useTranslate();
  const file = componentRuleFile(component);
  const rules = props.roleRules;
  const entries = (anchor: HTMLElement | undefined): readonly MenuEntry[] => [
    {
      kind: 'item',
      id: 'instances',
      label: translate('palette.roles.showInstances'),
      disabled: anchor === undefined || component.instances === undefined || component.instances === 0,
      onSelect: () => {
        if (anchor !== undefined) {
          void props.openUsage(component, anchor);
        }
      },
    },
    ...(rules === undefined || file === undefined ? [] : [rolesSubmenu(rules, { kind: 'component', path: file }, [file], translate)]),
  ];
  return <PaletteRowMenu entries={entries} name={prettyComponentName(component.name)} onOpenChange={props.preview.block} />;
}

// The same for a folder header: Roles over the folder, counting every component the folder holds (nothing else applies to a folder here).
function FolderRoles({ folder, props }: { readonly folder: string; readonly props: PaletteListProps }) {
  const translate = useTranslate();
  const files = props.allComponents
    .filter((component) => component.folder === folder)
    .flatMap((component) => {
      const file = componentRuleFile(component);
      return file === undefined ? [] : [file];
    });
  const first = files[0];
  const rules = props.roleRules;
  const path = first === undefined ? '' : first.slice(0, first.lastIndexOf('/'));
  if (rules === undefined || path === '') {
    return undefined;
  }
  const entries = (): readonly MenuEntry[] => [rolesSubmenu(rules, { kind: 'folder', path }, files, translate)];
  return <PaletteRowMenu entries={entries} name={folder} onOpenChange={props.preview.block} />;
}

function startComponentDrag(event: React.DragEvent<HTMLDivElement>, component: ScanComponent, props: PaletteListProps): void {
  props.preview.cancel();
  event.dataTransfer.setData('avb/component', component.name);
  event.dataTransfer.setData('avb/component-path', component.path);
  allowDragEffect(event.dataTransfer, 'copy');
  setDrag({ kind: 'component', name: component.name });
  if (props.onDragBegin) {
    setTimeout(props.onDragBegin, 0);
  }
}

function PaletteEmpty({ count, query }: { readonly count: number; readonly query: string }) {
  const translateRich = useTranslateRich();
  const translate = useTranslate();
  return (
    <div className="props-empty">
      {count === 0 ? translateRich('palette.panel.none', { folder: <code>src/components</code> }) : translate('palette.panel.noMatch', { query: query.trim() })}
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
          preview={preview}
          devURL={props.devUrl}
          trailingSlash={props.trailingSlash}
          {...(props.resolvePreviewURL ? { resolvePreviewURL: props.resolvePreviewURL } : {})}
        />
      )}
    </>
  );
}
