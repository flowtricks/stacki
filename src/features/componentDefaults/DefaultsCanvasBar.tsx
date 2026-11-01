import { ErrorToast } from '../../ui/ErrorToast';
import type { useDefaultsCanvas } from './useDefaultsCanvas';
import './componentDefaults.css';

// Keep a failed defaults save recoverable without adding another editing toolbar.
export function DefaultsCanvasBar({ canvas }: { readonly canvas: ReturnType<typeof useDefaultsCanvas> }) {
  const state = canvas.state;
  if (state.kind === 'idle' || (!state.message && canvas.isOpen)) {
    return undefined;
  }
  return (
    <ErrorToast
      message={state.message}
      recovery={[
        ...(!canvas.isOpen ? [{ label: 'Return to defaults', run: () => canvas.run('resume') }] : []),
        ...(state.kind !== 'saving' ? [{ label: 'Discard changes', run: () => canvas.run('discard') }] : []),
      ]}
    />
  );
}
