import type { CanvasTextTarget } from '../../../shared/properties/canvasText';
import type { CanvasTextOverlayEvent } from '../../../shared/properties/canvasTextOverlay';

export function createCanvasTextOverlay(options: {
  readonly target: (key: string) => CanvasTextTarget | undefined;
  readonly post: (message: unknown) => void;
}) {
  let active: { readonly session: string; readonly label: string } | undefined;
  let indicator: HTMLDivElement | undefined;
  const clear = () => {
    indicator?.remove();
    indicator = undefined;
    active = undefined;
  };
  const close = () => {
    if (active) {
      options.post({ type: 'avb:text-close', session: active.session, action: 'cancel' });
    }
    clear();
  };
  return {
    close,
    closeContent: () => {
      if (active?.label.startsWith('Shared CMS')) {
        close();
      }
    },
    receive: (message: CanvasTextOverlayEvent) => {
      clear();
      if (message.type === 'avb:text-inactive') {
        return;
      }
      const target = options.target(message.key);
      if (!target) {
        return;
      }
      active = { session: message.session, label: target.label };
      const containerElement = document.createElement('div');
      containerElement.id = 'stacki-canvas-text-editor';
      containerElement.hidden = true;
      if (target.label.startsWith('Shared')) {
        containerElement.dataset['shared'] = target.label.startsWith('Shared CMS') ? 'cms' : 'variable';
      }
      // A state marker colors the existing outline without adding a second editor.
      document.body.append(containerElement);
      indicator = containerElement;
    },
  };
}
