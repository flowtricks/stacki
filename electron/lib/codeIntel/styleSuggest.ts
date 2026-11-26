// Class and variable suggestions. What is offered follows what would apply: global names everywhere, a component's
// scoped names only inside that component, and a CSS module's classes only through its import.
import type { CodeCompletion, CodeCompletions } from '../../../shared/ipc/codeIntel';
import { folderOf, relativeSpecifier } from './paths';
import { resolveStyleImport, type FileStyles, type StyleVariable } from './styleIndex';
import { colorValue } from './styleSyntax';
import { completions, suggestion } from './suggestion';

export interface StyleSources {
  readonly root: string;
  /** The file being edited, from its unsaved text. */
  readonly current: FileStyles;
  /** Every other indexed file. */
  readonly others: readonly FileStyles[];
}

/** How many places a variable's other values are named. */
const VALUES_SHOWN_MAX = 6;

export function variableSuggestions(sources: StyleSources): readonly CodeCompletion[] {
  const found = new Map<string, { readonly variable: StyleVariable; readonly file: string; readonly own: boolean; readonly more: string[] }>();
  const add = (variable: StyleVariable, file: string, { own }: { readonly own: boolean }): void => {
    const kept = found.get(variable.name);
    if (kept === undefined) {
      found.set(variable.name, { variable, file, own, more: [] });
    } else if (kept.more.length < VALUES_SHOWN_MAX && variable.value !== kept.variable.value) {
      kept.more.push(`${variable.value}  /* ${variable.selector} · ${shortFile(sources.root, file)} */`);
    }
  };
  for (const variable of [...sources.current.symbols.variables, ...sources.current.definedVariables]) {
    add(variable, sources.current.file, { own: true });
  }
  // A root declaration is the value a reader means, so it is met first.
  const global = sources.others.flatMap((styles) =>
    styles.symbols.variables.filter((variable) => variable.global).map((variable) => ({ variable, file: styles.file })),
  );
  const rooted = (selector: string): number => (/(^|,\s*)(:root|html)\b|^@theme/.test(selector) ? 0 : 1);
  global.sort((left, right) => rooted(left.variable.selector) - rooted(right.variable.selector));
  for (const { variable, file } of global) {
    add(variable, file, { own: false });
  }
  return [...found.values()].map(({ variable, file, own, more }) =>
    suggestion(variable.name, 'cssVariable', {
      detail: `${variable.value}  ·  ${shortFile(sources.root, file)}`,
      color: colorValue(variable.value),
      boost: own ? 2 : 1,
      signature: [`${variable.name}: ${variable.value};  /* ${variable.selector} · ${shortFile(sources.root, file)} */`, ...more].join('\n'),
    }),
  );
}

/** Classes markup may write: global ones, and the file's own scoped ones. */
export function markupClassSuggestions(sources: StyleSources): readonly CodeCompletion[] {
  const found = new Map<string, CodeCompletion>();
  for (const entry of sources.current.symbols.classes) {
    found.set(entry.name, classSuggestion(entry.name, shortFile(sources.root, sources.current.file), 2));
  }
  for (const styles of sources.others) {
    if (styles.module) {
      continue;
    }
    for (const entry of styles.symbols.classes) {
      if (entry.global && !found.has(entry.name)) {
        found.set(entry.name, classSuggestion(entry.name, shortFile(sources.root, styles.file), 1));
      }
    }
  }
  return [...found.values()];
}

/** Classes a selector may name: those the file's own markup writes first, then classes known elsewhere. */
export function selectorClassSuggestions(sources: StyleSources): readonly CodeCompletion[] {
  const found = new Map<string, CodeCompletion>();
  const here = shortFile(sources.root, sources.current.file);
  for (const entry of sources.current.markupClasses) {
    found.set(entry.name, classSuggestion(entry.name, here, 3));
  }
  for (const styles of sources.others) {
    if (styles.module) {
      continue;
    }
    for (const entry of styles.symbols.classes) {
      if (entry.global && !found.has(entry.name)) {
        found.set(entry.name, classSuggestion(entry.name, shortFile(sources.root, styles.file), 2));
      }
    }
  }
  for (const styles of sources.others) {
    for (const entry of styles.markupClasses) {
      if (!found.has(entry.name)) {
        found.set(entry.name, classSuggestion(entry.name, shortFile(sources.root, styles.file), 1));
      }
    }
  }
  return [...found.values()].filter((item) => !/[^\w\u0080-￿-]/.test(item.label));
}

function classSuggestion(name: string, from: string, boost: number): CodeCompletion {
  return suggestion(name, 'cssClass', { detail: from, boost });
}

/** Sass and Less variables reach only through the file itself and what it imports. */
function preprocessorSuggestions(sources: StyleSources): readonly CodeCompletion[] {
  const found = new Map<string, CodeCompletion>();
  const byFile = new Map(sources.others.map((styles) => [styles.file, styles]));
  const pending: Array<{ readonly styles: FileStyles; readonly prefix: string }> = [{ styles: sources.current, prefix: '' }];
  const seen = new Set<string>([sources.current.file]);
  // Each file is visited once, so the index bounds the walk.
  for (const { styles, prefix } of pending) {
    for (const variable of styles.symbols.preprocessorVariables) {
      const name = `${prefix}${variable.name}`;
      if (!found.has(name)) {
        const detail = `${variable.value}  ·  ${shortFile(sources.root, styles.file)}`;
        found.set(name, suggestion(name, 'variable', { detail, color: colorValue(variable.value) }));
      }
    }
    for (const imported of styles.symbols.imports) {
      const target = resolveStyleImport(folderOf(styles.file), imported.specifier);
      const next = target === undefined ? undefined : byFile.get(target);
      if (next === undefined || seen.has(next.file)) {
        continue;
      }
      seen.add(next.file);
      // `@use` reaches its names through a namespace; the older `@import` brings them in bare.
      const namespace = imported.rule === 'use' ? `${imported.specifier.replace(/^.*[/:]/, '').replace(/^_|\.\w+$/g, '')}.` : '';
      pending.push({ styles: next, prefix: namespace });
    }
  }
  return [...found.values()];
}

/**
 * The suggestions for a place in a stylesheet: `text` is the sheet (or style block) up to the cursor, `language` its
 * grammar, `base` where it starts in the file. Undefined when the place wants the grammar's own suggestions.
 */
export function stylesheetCompletions(
  sources: StyleSources,
  sheet: { readonly before: string; readonly position: number; readonly language: string },
): CodeCompletions | undefined {
  const { before, position, language } = sheet;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const place = (typed: string) => ({ from: position - typed.length, to: position, typed, exclusive: true });
  const inVar = /var\(\s*(-{0,2}[\w\u0080-￿-]*)$/.exec(line);
  if (inVar !== null) {
    return completions(place(inVar[1] ?? ''), variableSuggestions(sources));
  }
  const declaring = /(?:^|[{;])\s*(--[\w\u0080-￿-]*)$/.exec(line);
  if (declaring !== null) {
    return completions(place(declaring[1] ?? ''), variableSuggestions(sources));
  }
  const sass = language === 'scss' || language === 'sass' ? /(?:^|[\s:(,{])((?:[\w-]+\.)?\$[\w-]*)$/ : undefined;
  const less = language === 'less' ? /:[^;{}]*[\s:(,](@[\w-]*)$/ : undefined;
  const preprocessor = (sass ?? less)?.exec(line)?.[1];
  if (preprocessor !== undefined) {
    return completions(place(preprocessor), preprocessorSuggestions(sources));
  }
  const dot = /\.([A-Za-z_\u0080-￿-][\w\u0080-￿-]*|)$/.exec(line);
  if (dot !== null && inSelector(before.slice(0, before.length - dot[0].length))) {
    return completions(place(dot[1] ?? ''), selectorClassSuggestions(sources));
  }
  return undefined;
}

// Whether a `.` after this text starts a class in a selector, rather than a decimal or a module's member in a value.
function inSelector(before: string): boolean {
  if (/\d$/.test(before)) {
    return false;
  }
  const start = Math.max(before.lastIndexOf('{'), before.lastIndexOf('}'), before.lastIndexOf(';'));
  const statement = before.slice(start + 1);
  return !/^\s*(?:[\w-]+|\$[\w-]+)\s*:\s/.test(statement.slice(statement.lastIndexOf('\n') + 1)) && !/^\s*@(import|use|forward)\b/.test(statement);
}

function shortFile(root: string, file: string): string {
  return relativeSpecifier(root, file).replace(/^\.\//, '');
}
