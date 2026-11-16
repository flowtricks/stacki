// What a `<style>` tag the Style panel creates starts with: the `newStyleTag` section of
// `.stacki/styles.json`. Two settings, both optional in the file:
//
// - `isGlobal`: whether the new tag carries `is:global`. Absent means no: a project that
//   never wrote the key keeps the scoped tags it always got. New Stacki projects are
//   written with it on (electron/project/newProjectDefaults.ts), because the Style panel
//   writes plain selectors and a scoped tag would hash them away from the element.
// - `content`: the template of the tag's body, with a placeholder for where rules go.
//
// The template rules (one place, so Desktop, Studio, the CLI and the Settings page agree):
//
// 1. The placeholder is the comment `/* stacki:rules */`. It is valid CSS, so a template that
//    still holds it can be saved, linted and highlighted like any stylesheet. Exactly one.
// 2. The placeholder may sit at the top level or inside at-rule blocks (`@layer`, `@media`, ...),
//    never inside a style rule, because rules are written there and a rule cannot hold one.
//    Inside blocks it names where rules go: the wrapper chain it sits in.
// 3. Without a placeholder, a template whose LAST top-level construct is a block at-rule
//    (`@layer components {}`, `@media (...) {}`, `@supports`, `@container`, `@scope`) puts
//    rules inside that block, after what it already holds. Any other template (empty,
//    `:root { ... }`, `@layer a, b;`) has rules appended after it at the top level. A rule
//    block such as `:root {}` is never a wrapper: appending inside it would write nested rules.
// 4. A placeholder at the top level means "after everything the template says": rules are
//    appended at the end of the tag, where the writer already appends.
//
// A tag FOLLOWS the template when its top level already holds the wrapper chain (same at-rule
// names and parameters, whitespace-insensitive). New rules then go inside the innermost
// wrapper, after the rules there. A tag that does not hold the chain is written exactly as
// before: at its top level. Stacki never wraps or moves rules a person wrote.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';

/** The comment that marks where rules go in a template. */
export const NEW_STYLE_TAG_RULES_TOKEN = '/* stacki:rules */';

// The token as written in a template: the comment's own text, whitespace-insensitive.
const TOKEN_COMMENT_BODY = 'stacki:rules';

/** Block at-rules that exist to contain rules, so a template ending in one means "rules go inside". */
const WRAPPER_AT_RULES: ReadonlySet<string> = new Set(['layer', 'media', 'supports', 'container', 'scope']);

/** `global`: the tag is written `<style is:global>`; `scoped`: a plain `<style>`. */
export type StyleTagScope = 'global' | 'scoped';

export interface NewStyleTagSettings {
  readonly scope: StyleTagScope;
  /** The template; empty means just the rules. */
  readonly content: string;
}

/** The behaviour of every project that never wrote the section. */
export const LEGACY_NEW_STYLE_TAG: NewStyleTagSettings = { scope: 'scoped', content: '' };

/** What a project made by Stacki starts with. */
export const NEW_PROJECT_NEW_STYLE_TAG: NewStyleTagSettings = { scope: 'global', content: '' };

export interface TemplateWrapper {
  /** Lower-case at-rule name without the `@`: `layer`. */
  readonly name: string;
  /** Parameters with whitespace squashed: `components`. */
  readonly params: string;
}

export interface TemplateFrame {
  /** The at-rule blocks rules go inside, outermost first; empty means the tag's top level. */
  readonly wrappers: readonly TemplateWrapper[];
  /** The template with the placeholder taken out: the tag's body before any rule is written. */
  readonly skeleton: string;
}

export type TemplateErrorCode = 'unbalanced' | 'repeated-placeholder' | 'placeholder-in-rule';

export type TemplateResult =
  { readonly ok: true; readonly frame: TemplateFrame } | { readonly ok: false; readonly error: { readonly code: TemplateErrorCode; readonly message: string } };

const MESSAGES: Record<TemplateErrorCode, string> = {
  unbalanced: 'The template has an unclosed brace, comment or string.',
  'repeated-placeholder': `The template names the rules placeholder ${NEW_STYLE_TAG_RULES_TOKEN} more than once.`,
  'placeholder-in-rule': `The placeholder ${NEW_STYLE_TAG_RULES_TOKEN} must sit at the top level or inside at-rule blocks such as @layer, not inside a style rule.`,
};

const fail = (code: TemplateErrorCode): TemplateResult => ({ ok: false, error: { code, message: MESSAGES[code] } });

interface OpenBlock {
  readonly open: number;
  readonly preludeStart: number;
}

interface ClosedBlock {
  readonly open: number;
  readonly close: number;
  readonly prelude: string;
}

interface Scan {
  readonly balanced: boolean;
  readonly placeholders: ReadonlyArray<{ readonly start: number; readonly end: number; readonly chain: readonly string[] }>;
  readonly topLevel: readonly ClosedBlock[];
}

/**
 * Reads the template's structure: where blocks open and close, and where the placeholder
 * sits. The loop visits each character once, so work is bounded by the template's length.
 */
function scanTemplate(content: string): Scan {
  const stack: OpenBlock[] = [];
  const placeholders: Array<{ start: number; end: number; chain: string[] }> = [];
  const topLevel: ClosedBlock[] = [];
  let preludeStart = 0;
  let balanced = true;
  let index = 0;
  while (index < content.length && balanced) {
    const char = content.charAt(index);
    const next = content.charAt(index + 1);
    if (char === '/' && next === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) {
        balanced = false;
      } else {
        if (content.slice(index + 2, end).trim() === TOKEN_COMMENT_BODY) {
          placeholders.push({ start: index, end: end + 2, chain: stack.map((block) => preludeOf(content, block)) });
        }
        index = end + 2;
      }
    } else if (char === '"' || char === "'") {
      const end = stringEnd(content, index);
      if (end < 0) {
        balanced = false;
      } else {
        index = end + 1;
      }
    } else if (char === '{') {
      stack.push({ open: index, preludeStart });
      preludeStart = index + 1;
      index += 1;
    } else if (char === '}') {
      const block = stack.pop();
      if (block === undefined) {
        balanced = false;
      } else {
        if (stack.length === 0) {
          topLevel.push({ open: block.open, close: index, prelude: preludeOf(content, block) });
        }
        preludeStart = index + 1;
        index += 1;
      }
    } else if (char === ';') {
      preludeStart = index + 1;
      index += 1;
    } else {
      index += 1;
    }
  }
  return { balanced: balanced && stack.length === 0, placeholders, topLevel };
}

// The end index of the string that opens at `from`, or -1 when it never closes on its line.
function stringEnd(content: string, from: number): number {
  const quote = content.charAt(from);
  for (let index = from + 1; index < content.length; index += 1) {
    const char = content.charAt(index);
    if (char === '\\') {
      index += 1;
    } else if (char === quote) {
      return index;
    } else if (char === '\n') {
      return -1;
    }
  }
  return -1;
}

function preludeOf(content: string, block: OpenBlock): string {
  return content
    .slice(block.preludeStart, block.open)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function wrapperOf(prelude: string): TemplateWrapper | undefined {
  const match = /^@([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(prelude);
  if (match === null) {
    return undefined;
  }
  const name = (match[1] ?? '').toLowerCase();
  return { name, params: squash(match[2] ?? '') };
}

/** Whitespace squashed to single spaces, the form at-rule parameters are compared in. */
export function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The structure of a template: the wrapper chain rules go in and the body to start from.
 * Expected failures (a template that is not CSS enough to place rules in) are values.
 */
export function templateFrame(content: string): TemplateResult {
  const scan = scanTemplate(content);
  if (!scan.balanced) {
    return fail('unbalanced');
  }
  if (scan.placeholders.length > 1) {
    return fail('repeated-placeholder');
  }
  const placeholder = scan.placeholders[0];
  if (placeholder !== undefined) {
    return placedFrame(content, placeholder);
  }
  const last = scan.topLevel[scan.topLevel.length - 1];
  if (last !== undefined && /^[\s]*$/.test(content.slice(last.close + 1).replace(/\/\*[\s\S]*?\*\//g, ''))) {
    const wrapper = wrapperOf(last.prelude);
    if (wrapper !== undefined && WRAPPER_AT_RULES.has(wrapper.name)) {
      return { ok: true, frame: { wrappers: [wrapper], skeleton: content } };
    }
  }
  return { ok: true, frame: { wrappers: [], skeleton: content } };
}

function placedFrame(content: string, placeholder: { readonly start: number; readonly end: number; readonly chain: readonly string[] }): TemplateResult {
  const wrappers: TemplateWrapper[] = [];
  for (const prelude of placeholder.chain) {
    const wrapper = wrapperOf(prelude);
    if (wrapper === undefined) {
      return fail('placeholder-in-rule');
    }
    wrappers.push(wrapper);
  }
  // A placeholder alone on its line leaves no blank line behind when it goes.
  const lineStart = content.lastIndexOf('\n', placeholder.start - 1) + 1;
  const lineEndAt = content.indexOf('\n', placeholder.end);
  const lineEnd = lineEndAt < 0 ? content.length : lineEndAt + 1;
  const alone = content.slice(lineStart, placeholder.start).trim() === '' && content.slice(placeholder.end, lineEnd).trim() === '';
  const skeleton = alone ? content.slice(0, lineStart) + content.slice(lineEnd) : content.slice(0, placeholder.start) + content.slice(placeholder.end);
  assert(!skeleton.includes(NEW_STYLE_TAG_RULES_TOKEN), 'templateFrame: the placeholder is gone from the skeleton');
  return { ok: true, frame: { wrappers, skeleton } };
}

/** The settings of a `newStyleTag` section; throws, with a reason, on a shape the file may not hold. */
export function parseNewStyleTag(input: unknown): NewStyleTagSettings {
  const value = record(input);
  if (value['version'] !== undefined && value['version'] !== 1) {
    throw new Error('Unsupported newStyleTag version');
  }
  const isGlobal = value['isGlobal'];
  if (isGlobal !== undefined && typeof isGlobal !== 'boolean') {
    throw new Error('newStyleTag.isGlobal: expected true or false');
  }
  const content = value['content'] === undefined ? '' : text(value['content']);
  const frame = templateFrame(content);
  if (!frame.ok) {
    throw new Error(`newStyleTag.content: ${frame.error.message}`);
  }
  return { scope: isGlobal === true ? 'global' : 'scoped', content };
}

/** The section as the file holds it. `content` is written only when there is one. */
export function newStyleTagDocument(settings: NewStyleTagSettings): Record<string, unknown> {
  const frame = templateFrame(settings.content);
  assert(frame.ok, 'newStyleTagDocument: the template parses');
  return settings.content === ''
    ? { version: 1, isGlobal: settings.scope === 'global' }
    : { version: 1, isGlobal: settings.scope === 'global', content: settings.content };
}

/** The opening tag a new style tag gets. */
export function newStyleTagOpening(scope: StyleTagScope): string {
  return scope === 'global' ? '<style is:global>' : '<style>';
}

/**
 * The tag as it would be created for the first rule: what the Settings preview shows. The
 * placeholder stays visible as a comment in the preview, so the person sees where rules land.
 */
export function newStyleTagPreview(settings: NewStyleTagSettings): string {
  const frame = templateFrame(settings.content);
  const body = frame.ok && settings.content.includes(NEW_STYLE_TAG_RULES_TOKEN) ? settings.content : frame.ok ? frame.frame.skeleton : settings.content;
  const inner = body.trim() === '' ? '  /* rules */' : body.replace(/\s+$/, '');
  return `${newStyleTagOpening(settings.scope)}\n${inner}\n</style>`;
}
