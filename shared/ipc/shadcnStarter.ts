import { boolean, object, optional, pathText, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { parseCreatePackageManager, type CreatePackageManager } from '../properties/packageManager';
import { parseAbsolutePath } from './astroCopy';

export const SHADCN_BASES = ['base', 'aria', 'radix'] as const;
export const SHADCN_ICON_LIBRARIES = ['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'] as const;
export const SHADCN_STYLES = ['vega', 'nova', 'maia', 'lyra', 'mira', 'luma', 'sera', 'rhea'] as const;
export type ShadcnBase = (typeof SHADCN_BASES)[number];
export type ShadcnIconLibrary = (typeof SHADCN_ICON_LIBRARIES)[number];
export type ShadcnStyle = (typeof SHADCN_STYLES)[number];

export interface ShadcnStarterOptions {
  readonly base: ShadcnBase;
  readonly style?: ShadcnStyle;
  readonly iconLibrary: ShadcnIconLibrary;
  readonly preset?: string;
  readonly pointer: boolean;
  readonly rtl: boolean;
}

export const SHADCN_STARTER_DEFAULTS = {
  base: 'base',
  style: 'nova',
  iconLibrary: 'lucide',
  pointer: false,
  rtl: false,
} as const satisfies ShadcnStarterOptions;

interface StarterLocation {
  readonly parentPath: string;
  readonly name: string;
  readonly packageManager?: CreatePackageManager;
}

export type StarterRequest = StarterLocation &
  (
    | { readonly starter?: 'lumos'; readonly shadcn?: never }
    | { readonly starter: 'heroui'; readonly shadcn?: never }
    | { readonly starter: 'shadcn'; readonly shadcn: ShadcnStarterOptions }
  );
export type ShadcnPresetReply = Result<{ readonly iconLibrary: ShadcnIconLibrary; readonly style: ShadcnStyle }, { readonly message: string }>;

export const SHADCN_PRESET_CODE_LENGTH_MAX = 32;
const SITE_NAME_LENGTH_MAX = 128;

export function parseStarterRequest(input: unknown): StarterRequest {
  const fields = record(input);
  const starter = fields['starter'];
  switch (starter) {
    case 'shadcn':
      return { ...parseStarterLocation(fields), starter, shadcn: parseShadcnOptions(fields['shadcn']) };
    case 'heroui':
      if ('shadcn' in fields) {
        throw new Error('shadcn options require the shadcn starter.');
      }
      return { ...parseStarterLocation(fields), starter };
    case 'lumos':
    case undefined: {
      if (fields['shadcn'] !== undefined) {
        throw new Error('shadcn options require the shadcn starter.');
      }
      const location = parseLumosLocation(fields);
      return starter === undefined ? location : { ...location, starter };
    }
    default:
      throw new Error('Unknown site starter.');
  }
}

/** Checks the bare argument before it can reach a shell. The shadcn CLI validates the code itself. */
export function parseShadcnPresetCode(input: unknown): string {
  const code = text(input);
  if (code.length <= SHADCN_PRESET_CODE_LENGTH_MAX) {
    if (/^[ab][0-9A-Za-z]+$/.test(code)) {
      return code;
    }
  }
  throw new Error('Enter a shadcn preset code.');
}

export const parseShadcnPresetRequest = object({ preset: parseShadcnPresetCode });

export function parseShadcnPresetReply(input: unknown): ShadcnPresetReply {
  const fields = record(input);
  if (boolean(fields['ok'])) {
    return ok(parseShadcnPresetSelection(fields['value']));
  }
  return err(parsePresetError(fields['error']));
}

const parseStarterLocation = object({
  parentPath: parseAbsolutePath,
  name: parseStarterName,
  packageManager: optional(parseCreatePackageManager),
});

const parseLumosLocation = object({ parentPath: pathText, name: text, packageManager: optional(parseCreatePackageManager) });

const parseShadcnOptions = object({
  base: parseShadcnBase,
  style: optional(parseShadcnStyle),
  iconLibrary: parseShadcnIconLibrary,
  preset: optional(parseShadcnPresetCode),
  pointer: boolean,
  rtl: boolean,
});

export const parseShadcnPresetSelection = object({ iconLibrary: parseShadcnIconLibrary, style: parseShadcnStyle });
export const parseShadcnIconSelection = object({ iconLibrary: parseShadcnIconLibrary });
const parsePresetError = object({ message: text });

export function parseStarterName(input: unknown): string {
  const name = text(input).trim();
  if (name.length <= SITE_NAME_LENGTH_MAX) {
    if (/^(?!-)(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(name)) {
      return name;
    }
  }
  throw new Error('Use letters, numbers, dashes, dots or underscores for the folder name.');
}

function parseShadcnBase(input: unknown): ShadcnBase {
  const base = SHADCN_BASES.find((candidate) => candidate === input);
  if (base === undefined) {
    throw new Error('Choose a supported shadcn base.');
  }
  return base;
}

function parseShadcnStyle(input: unknown): ShadcnStyle {
  const style = SHADCN_STYLES.find((candidate) => candidate === input);
  if (style === undefined) {
    throw new Error('Choose a supported shadcn style.');
  }
  return style;
}

function parseShadcnIconLibrary(input: unknown): ShadcnIconLibrary {
  const library = SHADCN_ICON_LIBRARIES.find((candidate) => candidate === input);
  if (library === undefined) {
    throw new Error('Choose a supported shadcn icon library.');
  }
  return library;
}
