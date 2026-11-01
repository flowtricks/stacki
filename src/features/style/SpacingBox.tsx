import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSharedVars } from './VariableConnect';
import { type SetProp, type ClearProp, type LiveSetProp, type Read, type SelectSelector, type Side } from './spacingTypes';
import { SpacingLabel } from './SpacingLabel';
import { SpacingEditor } from './SpacingEditor';
export { SpacingEditor } from './SpacingEditor';

export { SpacingLabel } from './SpacingLabel';

export { FRAMES, type FrameKey, SpacingFill } from './SpacingFill';

export { type SetProp, type ClearProp, type LiveSetProp, type Read, type SelectSelector, type Side } from './spacingTypes';

// ── Orchestration hook: drag-mirroring + which side's popover is open ─────────

type SharedProps = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onSelectSelector: SelectSelector;
};

// Wires the pieces together for one box (or a set of nested frames sharing a
// popover): returns a `label(prop, side)` renderer, the SpacingFill live handlers,
// and the editor node (or undefined when closed). `emptyLabel` is the placeholder for an
// unset side ("0" for margin/padding, "Auto" for inset).
export function useSpacingBox(
  shared: SharedProps,
  options?: { emptyLabel?: string; variableLabels?: boolean },
): {
  label: (prop: string, side: Side) => ReactNode;
  fillHandlers: { onLive: (props: string[], display: string) => void; onLiveEnd: () => void };
  editor: ReactNode;
} {
  const emptyLabel = options?.emptyLabel ?? '0';
  const { vars: variables } = useSharedVars({ active: !!options?.variableLabels });
  // The props the in-flight drag is writing and their shared live value, so every
  // matching label mirrors the drag in real time (only one drag runs at a time).
  const [liveDrag, setLiveDrag] = useState<{ props: string[]; value: string } | undefined>(undefined);
  const onLive = (dragProps: string[], value: string) => setLiveDrag({ props: dragProps, value });
  const onLiveEnd = () => setLiveDrag(undefined);

  // The side whose editor popover is open (undefined = closed).
  const [editing, setEditing] = useState<{ prop: string; side: Side } | undefined>(undefined);
  // When the open popover is closed by pressing its own label, the label's click
  // must NOT re-open it — this holds that prop so onEdit skips the reopen once.
  const suppressReopen = useRef<string | undefined>(undefined);
  const onEdit = (prop: string, side: Side) => {
    if (suppressReopen.current === prop) {
      suppressReopen.current = undefined;
      return;
    }
    suppressReopen.current = undefined;
    setEditing({ prop, side });
  };

  const label = (prop: string, side: Side) => (
    <SpacingLabel
      key={prop}
      prop={prop}
      side={side}
      override={liveDrag?.props.includes(prop) ? liveDrag.value : undefined}
      emptyLabel={emptyLabel}
      read={shared.read}
      busy={shared.busy}
      clearProp={shared.clearProp}
      onEdit={onEdit}
      variables={variables}
      {...(options?.variableLabels === undefined ? {} : { variableLabels: options.variableLabels })}
      setProp={shared.setProp}
      liveSetProp={shared.liveSetProp}
      onLive={onLive}
      onLiveEnd={onLiveEnd}
    />
  );

  const editor = editing ? (
    <SpacingEditor
      key={editing.prop}
      prop={editing.prop}
      side={editing.side}
      placeholder={emptyLabel}
      read={shared.read}
      setProp={shared.setProp}
      clearProp={shared.clearProp}
      liveSetProp={shared.liveSetProp}
      onSelectSelector={shared.onSelectSelector}
      onClose={() => setEditing(undefined)}
      onSameLabelPress={() => {
        suppressReopen.current = editing.prop;
      }}
    />
  ) : undefined;

  return { label, fillHandlers: { onLive, onLiveEnd }, editor };
}
