// One role's "Components" view in Settings → Roles (opened from its card, RoleDetail.tsx): which components the role may add from the insert
// palette and the Components panel (shared/properties/componentAccess.ts). The project's components show as a
// tree of folders and components, each with a switch (a folder's is three-state: all visible, some hidden, all
// hidden). Everything is visible until hidden, so a new component is enabled for every role. A folder switch
// sets all of it; a component's own switch can re-show one inside a hidden folder. Rows say when a folder
// decides them ("hidden by folder …"), a search filters the tree, and "Copy from" takes another role's choices.
// Hiding stops adding only: instances on pages stay. Rules for paths that no longer exist are listed apart.
//
// The tree is drawn as a window over its rows (fixed row height), so thousands of components cost a screenful
// of elements per frame. Changes save at once through the card's actions (RolesSettings.tsx).
import { useMemo, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  missingComponentRules,
  type ComponentDecision,
  type ComponentRule,
  type ComponentState,
  type ComponentTarget,
} from '../../../shared/properties/componentAccess';
import type { ProjectRole } from '../../../shared/properties/projectRoles';
import Dropdown from '../../ui/Dropdown';
import { ChevronRightIcon, CloseIcon, ElementComponentIcon, FolderIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { buildComponentTree, flattenRows, initialOpenFolders, type ComponentTreeRow, type FolderState } from './componentTree';

/** Height of one row, in pixels: the window arithmetic and the stylesheet agree on it. */
export const COMPONENT_ROW_HEIGHT = 32;
/** Rows drawn above and below what shows, so a fast scroll never reveals a gap. */
const OVERSCAN_ROWS = 6;
/** The tree's visible height, in rows. */
const VIEWPORT_ROWS = 12;

export interface RoleComponentsActions {
  readonly setVisibility: (target: ComponentTarget, state: ComponentState) => void;
  readonly copyFrom: (roleId: string) => void;
  readonly removeRule: (rule: ComponentRule) => void;
}

export function RoleComponents(props: {
  readonly role: ProjectRole;
  readonly editable: boolean;
  /** The project's component files, project-relative. */
  readonly files: readonly string[];
  /** The other roles whose choices can be copied. */
  readonly copySources: readonly { readonly id: string; readonly name: string }[];
  /** The detail view's search text (RoleDetail.tsx owns the field). */
  readonly query: string;
  readonly actions: RoleComponentsActions;
}) {
  const { role, editable, files, query, actions } = props;
  const translate = useTranslate();
  const tree = useMemo(() => buildComponentTree(files, role.componentRules), [files, role.componentRules]);
  const [open, setOpen] = useState<ReadonlySet<string> | undefined>(undefined);
  const opened = open ?? initialOpenFolders(tree);
  const rows = useMemo(() => flattenRows(tree, opened, query), [tree, opened, query]);
  const missing = useMemo(() => missingComponentRules(role.componentRules, files), [role.componentRules, files]);
  const toggleFolder = (path: string): void => {
    const next = new Set(opened);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setOpen(next);
  };
  return (
    <div className="app-role-components-body">
      {editable && props.copySources.length > 0 && (
        <div className="app-role-components-tools">
          <Dropdown
            ariaLabel={translate('settings.roles.components.copy')}
            className="app-roles-dropdown"
            value=""
            options={[
              { value: '', label: translate('settings.roles.components.copy'), disabled: true },
              ...props.copySources.map((source) => ({ value: source.id, label: source.name })),
            ]}
            onChange={(id) => (id === '' ? undefined : actions.copyFrom(id))}
          />
        </div>
      )}
      <ComponentRows rows={rows} editable={editable} empty={tree.total === 0 ? 'none' : 'noMatch'} toggleFolder={toggleFolder} actions={actions} />
      {missing.length > 0 && <MissingRules rules={missing} editable={editable} remove={actions.removeRule} />}
    </div>
  );
}

function ComponentRows(props: {
  readonly rows: readonly ComponentTreeRow[];
  readonly editable: boolean;
  readonly empty: 'none' | 'noMatch';
  readonly toggleFolder: (path: string) => void;
  readonly actions: RoleComponentsActions;
}) {
  const translate = useTranslate();
  const [scrollTop, setScrollTop] = useState(0);
  const { rows } = props;
  if (rows.length === 0) {
    return (
      <p className="app-role-components-empty">{translate(props.empty === 'none' ? 'settings.roles.components.none' : 'settings.roles.components.noMatch')}</p>
    );
  }
  const first = Math.max(0, Math.floor(scrollTop / COMPONENT_ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((scrollTop + VIEWPORT_ROWS * COMPONENT_ROW_HEIGHT) / COMPONENT_ROW_HEIGHT) + OVERSCAN_ROWS);
  assert(last - first <= VIEWPORT_ROWS + 2 * OVERSCAN_ROWS + 1, 'The window draws a bounded number of rows');
  return (
    <div
      className="app-role-components-tree"
      role="tree"
      style={{ maxHeight: VIEWPORT_ROWS * COMPONENT_ROW_HEIGHT }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: rows.length * COMPONENT_ROW_HEIGHT, position: 'relative' }}>
        {rows.slice(first, last).map((row, offset) => (
          <TreeRow key={`${row.kind}:${row.path}`} row={row} top={(first + offset) * COMPONENT_ROW_HEIGHT} {...props} />
        ))}
      </div>
    </div>
  );
}

function TreeRow(props: {
  readonly row: ComponentTreeRow;
  readonly top: number;
  readonly editable: boolean;
  readonly toggleFolder: (path: string) => void;
  readonly actions: RoleComponentsActions;
}) {
  const { row, actions } = props;
  const translate = useTranslate();
  const target: ComponentTarget = { kind: row.kind, path: row.path };
  const check: FolderState = row.kind === 'folder' ? row.state : row.state;
  // From all-visible a click hides; from hidden or mixed it shows, so "mixed" is only ever a way back to everything.
  const next: ComponentState = check === 'visible' ? 'hidden' : 'visible';
  const note = rowNote(row.kind === 'folder' ? row.inherited : row.decision, row.kind, translate);
  return (
    <div
      className="app-role-components-row"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === 'folder' ? row.disclosure === 'open' : undefined}
      style={{ top: props.top, paddingInlineStart: 8 + row.depth * 16 }}
    >
      {row.kind === 'folder' ? (
        <button
          type="button"
          className="app-role-components-twist"
          data-open={row.disclosure === 'open' ? 'true' : 'false'}
          aria-label={translate('settings.roles.components.expand', { name: row.name })}
          onClick={() => props.toggleFolder(row.path)}
        >
          <ChevronRightIcon size={10} />
        </button>
      ) : (
        <span className="app-role-components-twist" aria-hidden="true" />
      )}
      <span className="app-role-components-icon" aria-hidden="true">
        {row.kind === 'folder' ? <FolderIcon size={14} /> : <ElementComponentIcon size={14} />}
      </span>
      <span className="app-role-components-name" title={row.path}>
        {row.name}
      </span>
      {row.kind === 'folder' && (
        <span className="app-role-components-folder-count">
          {translate('settings.roles.components.folderCount', { visible: row.visible, total: row.total })}
        </span>
      )}
      {note !== undefined && <span className="app-role-components-note">{note}</span>}
      <button
        type="button"
        className="app-role-components-check"
        role="checkbox"
        aria-checked={check === 'mixed' ? 'mixed' : check === 'visible'}
        aria-label={translate(next === 'hidden' ? 'settings.roles.components.hide' : 'settings.roles.components.show', { name: row.name })}
        data-state={check}
        disabled={!props.editable}
        onClick={() => actions.setVisibility(target, next)}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

// What explains a row beyond its switch: the folder that decides it, or its own override.
function rowNote(decision: ComponentDecision, kind: 'folder' | 'component', translate: Translator): string | undefined {
  switch (decision.kind) {
    case 'default':
      return undefined;
    case 'folder':
      return translate(decision.effect === 'hide' ? 'settings.roles.components.hiddenBy' : 'settings.roles.components.shownBy', { folder: decision.folder });
    case 'component':
      return kind === 'component'
        ? translate(decision.effect === 'hide' ? 'settings.roles.components.hiddenOwn' : 'settings.roles.components.shownOwn')
        : undefined;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function MissingRules(props: { readonly rules: readonly ComponentRule[]; readonly editable: boolean; readonly remove: (rule: ComponentRule) => void }) {
  const translate = useTranslate();
  return (
    <div className="app-role-components-missing">
      <h4>{translate('settings.roles.components.missing')}</h4>
      {props.rules.map((rule) => (
        <div key={`${rule.kind}:${rule.path}`} className="app-role-components-row app-role-components-missing-row">
          <span className="app-role-components-name" title={rule.path}>
            {rule.path}
          </span>
          <span className="app-role-components-note">
            {translate(rule.effect === 'hide' ? 'settings.roles.components.hiddenOwn' : 'settings.roles.components.shownOwn')}
          </span>
          {props.editable && (
            <button
              type="button"
              className="app-role-icon"
              aria-label={translate('settings.roles.components.removeRule', { path: rule.path })}
              onClick={() => props.remove(rule)}
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
