// The slice of the Webflow Designer extension API the clip-path editor talks to,
// described as the Designer delivers it. The API is not ours: it spells absence
// with `null` (a style with no parent, an element with no styles), so these
// types say `null` where it does. The editor converts at the call site — a
// truthiness test, `=== null`, or `?? undefined` — and its own values use
// `undefined` (AGENTS.md §6).

/** A value the Designer API reports as absent with its own `null`. */
export type ApiNullable<T> = T | null;

export type BreakpointId = 'xxl' | 'xl' | 'large' | 'main' | 'medium' | 'small' | 'tiny';
export type StyleTargetOptions = { breakpoint?: BreakpointId };

export type StyleHandle = {
  readonly id?: string;
  getName?: () => Promise<string>;
  setProperty?: (property: string, value: string, options?: StyleTargetOptions) => Promise<null | void>;
  getProperty?: (property: string, options?: StyleTargetOptions) => Promise<string | null | undefined>;
  getProperties?: (options?: StyleTargetOptions) => Promise<Record<string, unknown> | null | undefined>;
  removeProperty?: (property: string, options?: StyleTargetOptions) => Promise<null | void>;
  getParent?: () => Promise<StyleHandle | null>;
};
export type ElementAttributeHandle = { name?: unknown; value?: unknown };
export type ElementStyleSource = {
  readonly id?: unknown;
  getStyles?: () => Promise<Array<StyleHandle | null> | null>;
  getStyle?: () => Promise<StyleHandle | null>;
  getAttributeValue?: (name: string) => Promise<unknown>;
  getResolvedAttributeValue?: (name: string) => Promise<unknown>;
  getAttributes?: () => Promise<Array<ElementAttributeHandle> | null>;
  getResolvedAttributes?: () => Promise<Array<ElementAttributeHandle> | null>;
  getCustomAttribute?: (name: string) => Promise<unknown>;
  getAllCustomAttributes?: () => Promise<Array<ElementAttributeHandle> | null>;
};
export type WebflowStyleLookup = {
  getStyleByName?: (nameOrPath: string | string[]) => Promise<StyleHandle | null>;
  getAllStyles?: () => Promise<StyleHandle[]>;
};
export type WebflowStyleEditor = WebflowStyleLookup & {
  createStyle?: (name: string, options?: { parent?: StyleHandle }) => Promise<StyleHandle>;
};
export type WebflowSelectionApi = WebflowStyleLookup & {
  getSelectedElement?: () => Promise<unknown>;
};
export type WebflowBreakpointApi = {
  getMediaQuery?: () => Promise<BreakpointId>;
  subscribe?: {
    (event: 'selectedelement', callback: (element: unknown) => void): (() => void) | undefined;
    (event: 'mediaquery', callback: (breakpoint: BreakpointId) => void): (() => void) | undefined;
  };
};
export type WebflowApi = WebflowStyleEditor & WebflowSelectionApi & WebflowBreakpointApi;
