// The question asked before a component (or a folder of them) is deleted from the Components panel (docs/components.md,
// "Deleting a component"). Main reads the site and says what the deletion would take out; the dialog says it back in
// short lines: the file going to the Trash, the instances and imports leaving which files, the settings cleaned, and that
// one Undo restores all of it. A use Stacki cannot rewrite blocks the deletion, and the dialog lists those places by line.
//
// It is the window's own confirmation (ConfirmDialog.tsx), never a native one.
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  componentRemovalBlocked,
  componentRemovalTotal,
  type ComponentRemovalFile,
  type ComponentRemovalPreview,
  type ComponentRemovalReviewKind,
} from '../../../shared/properties/componentRemoval';
import type { Translator } from '../../lib/i18n/localeContext';
import { choiceDialog, confirmDialog } from '../../ui/ConfirmDialog';
import '../../features/componentProperties/propertyRemoval.css';

/** How many files or lines a list shows before it says how many more there are: the dialog stays short on a large site. */
export const COMPONENT_REMOVAL_ROWS_MAX = 6;

/** Asks whether to delete, from main's preview; true only when the person confirmed a deletion that can go ahead. */
export async function confirmComponentRemoval(preview: ComponentRemovalPreview, translate: Translator): Promise<boolean> {
  if (componentRemovalBlocked(preview)) {
    await choiceDialog({
      title: translate('palette.remove.blockedTitle', { name: preview.name }),
      body: <BlockedBody preview={preview} translate={translate} />,
      choices: [],
      cancelLabel: translate('ui.close'),
    });
    return false;
  }
  const answer = await confirmDialog({
    title: translate('palette.manage.deleteTitle', { name: preview.name }),
    body: <RemovalBody preview={preview} translate={translate} />,
    confirmLabel: translate('palette.manage.deleteConfirm'),
    danger: true,
  });
  return answer === true;
}

function RemovalBody({ preview, translate }: { readonly preview: ComponentRemovalPreview; readonly translate: Translator }) {
  const instances = componentRemovalTotal(preview.instances);
  const imports = componentRemovalTotal(preview.imports);
  return (
    <ul className="property-removal">
      <li>{translate('palette.remove.files', { name: preview.name, count: preview.files })}</li>
      {instances === 0 && imports === 0 && <li>{translate('palette.remove.unused')}</li>}
      {instances > 0 && (
        <li>
          {translate('palette.remove.instances', { count: instances })}
          <FileRows files={preview.instances} translate={translate} />
        </li>
      )}
      {imports > 0 && (
        <li>
          {translate('palette.remove.imports', { count: imports })}
          <FileRows files={preview.imports} translate={translate} />
        </li>
      )}
      {preview.settings.length > 0 && <li>{translate('palette.remove.settings', { files: preview.settings.join(', ') })}</li>}
      <li>{translate('palette.remove.undo')}</li>
    </ul>
  );
}

function BlockedBody({ preview, translate }: { readonly preview: ComponentRemovalPreview; readonly translate: Translator }) {
  assert(preview.reviews.length > 0, 'A blocked deletion lists what blocks it');
  return (
    <ul className="property-removal">
      <li>
        {translate('palette.remove.blocked')}
        <BoundedRows
          rows={preview.reviews.map((review) => ({
            key: `${review.path}:${String(review.line)}:${review.kind}`,
            text: translate('palette.remove.reviewLine', { path: review.path, line: review.line, reason: translate(REASON_KEYS[review.kind]) }),
          }))}
          translate={translate}
        />
      </li>
    </ul>
  );
}

const REASON_KEYS = {
  'dynamic-import': 'palette.remove.reason.dynamicImport',
  glob: 'palette.remove.reason.glob',
  're-export': 'palette.remove.reason.reExport',
  value: 'palette.remove.reason.value',
  expression: 'palette.remove.reason.expression',
  content: 'palette.remove.reason.content',
  layout: 'palette.remove.reason.layout',
  unreadable: 'palette.remove.reason.unreadable',
} as const satisfies Record<ComponentRemovalReviewKind, string>;

function FileRows({ files, translate }: { readonly files: readonly ComponentRemovalFile[]; readonly translate: Translator }) {
  return (
    <BoundedRows
      rows={files.map((file) => ({ key: file.path, text: translate('palette.remove.place', { path: file.path, count: file.count }) }))}
      translate={translate}
    />
  );
}

function BoundedRows({ rows, translate }: { readonly rows: readonly { readonly key: string; readonly text: ReactNode }[]; readonly translate: Translator }) {
  const shown = rows.slice(0, COMPONENT_REMOVAL_ROWS_MAX);
  const hidden = rows.length - shown.length;
  assert(hidden >= 0, 'A list hides no more rows than it has');
  return (
    <ul className="property-removal-rows">
      {shown.map((row) => (
        <li key={row.key}>{row.text}</li>
      ))}
      {hidden > 0 && <li className="property-removal-more">{translate('palette.remove.more', { count: hidden })}</li>}
    </ul>
  );
}
