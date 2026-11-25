// Design mode's right panel: "Design" (the selected instance's props, then its styles) and "Layers".
import { useState } from 'react';
import SegmentedControl from '../../../ui/SegmentedControl';
import TipAnchor from '../../../ui/TipAnchor';
import { instanceKeyOf, isHidden } from '../model/designDom';
import { selectedElements, useDesignState } from '../runtime/designSession';
import { deleteSelection, duplicateSelection, resetSelection, toggleHiddenSelection } from '../runtime/designGestures';
import type { DesignWords } from '../i18n/designWords';
import { DesignComponentPanel } from './DesignComponentPanel';
import { DesignLayers } from './DesignLayers';
import { DesignStylePanel } from './DesignStylePanel';
import { CopyIcon, DeleteIcon, HideIcon, ResetIcon, ShowIcon } from './designIcons';

type InspectorTab = 'design' | 'layers';

export function DesignInspector({ words }: { readonly words: DesignWords }) {
  const state = useDesignState();
  const [tab, setTab] = useState<InspectorTab>('design');
  const selected = selectedElements();
  const frame = selected?.frame ?? state.frameSelected ?? state.frames[0]?.id;
  const elements = selected?.elements ?? [];
  const first = elements[0];
  const hidden = elements.length > 0 && elements.every(isHidden);
  return (
    <aside className="dm-inspector" data-revision={state.revision}>
      <div className="dm-inspector-tabs">
        <SegmentedControl
          options={[
            { value: 'design', label: words('inspector.style') },
            { value: 'layers', label: words('inspector.layers') },
          ]}
          value={tab}
          ariaLabel={words('inspector.style')}
          onChange={setTab}
        />
      </div>
      <div className="dm-inspector-body">
        {tab === 'layers' && frame !== undefined && <DesignLayers frame={frame} words={words} />}
        {tab === 'design' && first === undefined && <div className="dm-inspector-empty">{words('inspector.empty')}</div>}
        {tab === 'design' && first !== undefined && selected !== undefined && (
          <>
            <div className="dm-selection-bar">
              <span className="dm-selection-count">
                {elements.length > 1 ? words('inspector.selected', { count: elements.length }) : first.tagName.toLowerCase()}
              </span>
              <span className="dm-space" />
              <Action label={words('element.duplicate')} onClick={() => duplicateSelection()}>
                <CopyIcon size={16} />
              </Action>
              <Action label={hidden ? words('element.show') : words('element.hide')} onClick={() => toggleHiddenSelection()}>
                {hidden ? <ShowIcon size={16} /> : <HideIcon size={16} />}
              </Action>
              <Action label={words('element.reset')} tip={words('element.resetTip')} onClick={() => resetSelection()}>
                <ResetIcon size={16} />
              </Action>
              <Action label={words('element.delete')} onClick={() => deleteSelection()}>
                <DeleteIcon size={16} />
              </Action>
            </div>
            {elements.length === 1 && instanceKeyOf(first) !== undefined && <DesignComponentPanel frame={selected.frame} element={first} words={words} />}
            <DesignStylePanel elements={elements} words={words} />
          </>
        )}
      </div>
    </aside>
  );
}

function Action({
  label,
  tip,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tip?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <TipAnchor text={tip ?? label}>
      <button type="button" className="ghost dm-icon-button" aria-label={label} onClick={onClick}>
        {children}
      </button>
    </TipAnchor>
  );
}
