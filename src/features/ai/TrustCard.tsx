// The question the AI panel asks once per project before any agent may work in it. It is a permission, so it keeps
// every fact the person agrees to: agents can read, change and run anything in the project; their edits apply right
// away; each changed file can be kept or undone after. Said as three short points, scannable at the panel's narrowest
// width, then one blue button. While the answer is being saved the button says so and takes no second press; a
// refusal is told by the panel's error toast (aiStore.ts trustProject), never by nothing.
import { useState } from 'react';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { centralIcon } from '../../ui/central/CentralIcon';
import { edit as centralEdit, robot as centralRobot, undo as centralUndo } from '../../ui/central/centralGeometry';
import { trustProject } from './aiStore';

const RobotGlyph = centralIcon(centralRobot);
const EditGlyph = centralIcon(centralEdit);
const UndoGlyph = centralIcon(centralUndo);

const POINTS = [
  { key: 'ai.trust.pointAccess', Icon: RobotGlyph },
  { key: 'ai.trust.pointLive', Icon: EditGlyph },
  { key: 'ai.trust.pointReview', Icon: UndoGlyph },
] as const satisfies readonly { readonly key: MessageKey; readonly Icon: typeof RobotGlyph }[];

export function TrustCard() {
  const translate = useTranslate();
  const [saving, setSaving] = useState(false);
  return (
    <section className="ai-trust" aria-labelledby="ai-trust-title">
      <h3 id="ai-trust-title" className="ai-trust-title">
        {translate('ai.trust.title')}
      </h3>
      <ul className="ai-trust-points">
        {POINTS.map(({ key, Icon }) => (
          <li key={key}>
            <span className="ai-trust-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <span>{translate(key)}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="primary ai-trust-allow"
        aria-busy={saving}
        aria-disabled={saving}
        onClick={() => {
          if (saving) {
            return;
          }
          setSaving(true);
          void trustProject().finally(() => setSaving(false));
        }}
      >
        {saving ? translate('ai.trust.allowing') : translate('ai.trust.allow')}
      </button>
    </section>
  );
}
