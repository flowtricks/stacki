// The question asked before a prop is deleted (docs/component-properties.md,
// "Deleting a prop"). Main reads the site and says what the deletion would
// take out; the dialog says it back in short lines: the prop, the instances
// that pass it and in which files, what is left for a person to check, and
// that one Undo restores all of it. When the component's own code still reads
// the prop, nothing can be deleted yet, and the dialog lists those lines.
//
// It is the window's own confirmation (ConfirmDialog.tsx), never a native one.
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { PropertyRemovalPreview, PropertyRemovalReview } from '../../../shared/properties/propertyRemoval';
import { removalBlocked, removalUsageCount } from '../../../shared/properties/propertyRemoval';
import type { Translator } from '../../lib/i18n/localeContext';
import { propertyErrorTextFor } from '../../lib/i18n/propertyErrorText';
import { choiceDialog, confirmDialog } from '../../ui/ConfirmDialog';
import { previewPropertyRemoval } from './propertiesBridge';
import './propertyRemoval.css';

/** How many files or lines a list shows before it says how many more there are: the dialog stays short on a large site. */
export const REMOVAL_ROWS_MAX = 6;

interface RemovalQuestion {
  readonly projectPath: string;
  readonly file: string;
  readonly name: string;
  readonly translate: Translator;
}

/** Asks whether to delete the prop, after reading what that would do; true only when the person confirmed a deletion that can go ahead. */
export async function confirmPropertyRemoval(question: RemovalQuestion): Promise<boolean> {
  const { translate, name } = question;
  const preview = await previewPropertyRemoval(question.projectPath, question.file, name);
  if (!preview.ok) {
    await choiceDialog({
      title: translate('props.remove.blockedTitle', { name }),
      body: (
        <ul className="property-removal">
          <li>{translate('props.remove.checkFailed', { name })}</li>
          <li className="property-removal-detail">{propertyErrorTextFor(preview.error, translate)}</li>
        </ul>
      ),
      choices: [],
      cancelLabel: translate('ui.close'),
    });
    return false;
  }
  assert(preview.value.name === name, 'The preview is of the prop asked about');
  if (removalBlocked(preview.value)) {
    await choiceDialog({
      title: translate('props.remove.blockedTitle', { name }),
      body: <BlockedBody preview={preview.value} translate={translate} />,
      choices: [],
      cancelLabel: translate('ui.close'),
    });
    return false;
  }
  const answer = await confirmDialog({
    title: translate('props.remove.title', { name }),
    body: <RemovalBody preview={preview.value} translate={translate} />,
    confirmLabel: translate('props.remove.confirm'),
    danger: true,
  });
  return answer === true;
}

function RemovalBody({ preview, translate }: { readonly preview: PropertyRemovalPreview; readonly translate: Translator }) {
  const total = removalUsageCount(preview);
  const spreads = preview.reviews.filter((review) => review.kind === 'spread');
  return (
    <ul className="property-removal">
      <li>{translate('props.remove.component', { name: preview.name, component: preview.component })}</li>
      {total === 0 ? (
        <li>{translate('props.remove.noUsages')}</li>
      ) : (
        <li>
          {translate('props.remove.usages', { count: total })}
          <BoundedRows
            rows={preview.usages.map((usage) => ({ key: usage.path, text: translate('props.remove.usageFile', { path: usage.path, count: usage.count }) }))}
            translate={translate}
          />
        </li>
      )}
      {spreads.length > 0 && (
        <li>
          {translate('props.remove.spreads')}
          <ReviewRows reviews={spreads} translate={translate} />
        </li>
      )}
      <li>{translate('props.remove.undo')}</li>
    </ul>
  );
}

function BlockedBody({ preview, translate }: { readonly preview: PropertyRemovalPreview; readonly translate: Translator }) {
  const reads = preview.reviews.filter((review) => review.kind === 'reads');
  assert(reads.length > 0, 'A blocked deletion lists what blocks it');
  return (
    <ul className="property-removal">
      <li>
        {translate('props.remove.reads')}
        <ReviewRows reviews={reads} translate={translate} />
      </li>
    </ul>
  );
}

function ReviewRows({ reviews, translate }: { readonly reviews: readonly PropertyRemovalReview[]; readonly translate: Translator }) {
  return (
    <BoundedRows
      rows={reviews.map((review) => ({
        key: `${review.path}:${String(review.line)}`,
        text: translate('props.remove.reviewLine', { path: review.path, line: review.line }),
      }))}
      translate={translate}
    />
  );
}

function BoundedRows({ rows, translate }: { readonly rows: readonly { readonly key: string; readonly text: ReactNode }[]; readonly translate: Translator }) {
  const shown = rows.slice(0, REMOVAL_ROWS_MAX);
  const hidden = rows.length - shown.length;
  assert(hidden >= 0, 'A list hides no more rows than it has');
  return (
    <ul className="property-removal-rows">
      {shown.map((row) => (
        <li key={row.key}>{row.text}</li>
      ))}
      {hidden > 0 && <li className="property-removal-more">{translate('props.remove.moreFiles', { count: hidden })}</li>}
    </ul>
  );
}
