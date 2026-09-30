import type { PreloadBridge } from '../../shared/preload-api';
import { parseIpcPayload } from '../../shared/ipc-payloads';
import { boolean, record, text } from '../../shared/boundary';

const RESTART = 'Stacki needs to be restarted before this can be used.';
export type VariableEditResult =
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly css?: string };

// Preparing calls validates payloads outside the I/O catch. A bad program request
// must remain loud; missing handlers and disk failures are expected operating errors.
const edits = {
  readStyleFile(input: unknown) {
    const payload = parseIpcPayload('style:readFile', input);
    return () => window.avb.readStyleFile(payload);
  },
  writeStyleFile(input: unknown) {
    const payload = parseIpcPayload('style:writeFile', input);
    return () => window.avb.writeStyleFile(payload);
  },
  setCssVariable(input: unknown) {
    const payload = parseIpcPayload('css:setVariable', input);
    return () => window.avb.setCssVariable(payload);
  },
  moveCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:moveVariables', input);
    return () => window.avb.moveCssVariables(payload);
  },
  createVariablesFile(input: unknown) {
    const payload = parseIpcPayload('css:createVariablesFile', input);
    return () => window.avb.createVariablesFile(payload);
  },
  addCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:addVariables', input);
    return () => window.avb.addCssVariables(payload);
  },
  renameCssVariables(input: unknown) {
    const payload = parseIpcPayload('css:renameVariables', input);
    return () => window.avb.renameCssVariables(payload);
  },
  setCssSectionTitle(input: unknown) {
    const payload = parseIpcPayload('css:setSectionTitle', input);
    return () => window.avb.setCssSectionTitle(payload);
  },
  addCssSection(input: unknown) {
    const payload = parseIpcPayload('css:addSection', input);
    return () => window.avb.addCssSection(payload);
  },
  removeCssSection(input: unknown) {
    const payload = parseIpcPayload('css:removeSection', input);
    return () => window.avb.removeCssSection(payload);
  },
  moveCssHeading(input: unknown) {
    const payload = parseIpcPayload('css:moveHeading', input);
    return () => window.avb.moveCssHeading(payload);
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
  if (typeof window.avb?.[name] !== 'function') {
    return { ok: false, error: RESTART };
  }
  const invoke = edits[name](payload);
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
