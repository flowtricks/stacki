import { styleTransport } from './editorEnvironment';
import { editVariables, hasVariableCommand } from './editorEnvironment';
import type { PreloadBridge } from '../../shared/ipc/preloadApi';
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { boolean, record, text } from '../../shared/core/boundary';

const RESTART = 'Stacki needs to be restarted before this can be used.';
export type VariableEditResult = { readonly ok: false; readonly error: string } | { readonly ok: true; readonly css?: string };

// Preparing calls validates payloads outside the I/O catch. A bad program request
// must remain loud; missing handlers and disk failures are expected operating errors.
const edits = {
  readStyleFile(input: unknown) {
    const payload = parseIpcPayload('style:readFile', input);
    return () => styleTransport.readStyleFile(payload);
  },
  writeStyleFile(input: unknown) {
    const payload = parseIpcPayload('style:writeFile', input);
    return () => styleTransport.writeStyleFile(payload);
  },
  setCssVariable(input: unknown) {
    const payload = parseIpcPayload('css:setVariable', input);
    return () => editVariables('setCssVariable', payload);
  },
  moveCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:moveVariables', input);
    return () => editVariables('moveCssVariables', payload);
  },
  addCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:addVariables', input);
    return () => editVariables('addCssVariables', payload);
  },
  renameCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:renameVariables', input);
    return () => editVariables('renameCssVariables', payload);
  },
  setCssSectionTitle(input: unknown) {
    const payload = parseIpcPayload('css:setSectionTitle', input);
    return () => editVariables('setCssSectionTitle', payload);
  },
  addCssSection(input: unknown) {
    const payload = parseIpcPayload('css:addSection', input);
    return () => editVariables('addCssSection', payload);
  },
  removeCssSection(input: unknown) {
    const payload = parseIpcPayload('css:removeSection', input);
    return () => editVariables('removeCssSection', payload);
  },
  moveCssHeading(input: unknown) {
    const payload = parseIpcPayload('css:moveHeading', input);
    return () => editVariables('moveCssHeading', payload);
  },
};
type EditName = keyof typeof edits;
type ReadonlyPayload<Value> = Value extends readonly unknown[]
  ? readonly ReadonlyPayload<Value[number]>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: ReadonlyPayload<Value[Key]> }
    : Value;

export async function variableEdit<Name extends EditName>(
  name: Name,
  payload: ReadonlyPayload<Parameters<PreloadBridge[Name]>[0]>,
): Promise<VariableEditResult> {
  const invoke = edits[name](payload);
  if (!hasVariableCommand(name)) {
    return { ok: false, error: RESTART };
  }
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: friendlyError(error) };
  }
  const value = record(response);
  if (name === 'readStyleFile') {
    return { ok: true, css: text(value['css']) };
  }
  if (boolean(value['ok'])) {
    return { ok: true };
  }
  return { ok: false, error: value['error'] === undefined ? '' : text(value['error']) };
}

export function friendlyError(error: unknown): string {
  let message = String(error);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    if (error.message) {
      message = String(error.message);
    }
  }
  const clean = message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  return /No handler registered/i.test(clean) ? RESTART : clean;
}
