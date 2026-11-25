import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postcss, { type Declaration } from 'postcss';
import ts from 'typescript';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { err, ok } from '../../shared/core/result';
import type { ShadcnSettingsChange, ShadcnSettingsReply } from '../../shared/ipc/shadcnSettings';
import { SHADCN_BASES } from '../../shared/ipc/shadcnStarter';
import { writeProjectText } from '../documents/documentWrites';
import { MAIN_LIMITS, readSource } from '../lib/mainLimits';
import { ensureToolPath } from '../lib/nodeTools';
import { SHADCN_CLI_PACKAGE } from './shadcnStarter';
import { shadcnStarterLayout } from './shadcnStarterContent';
import { shadcnThemePicker } from './shadcnStarterTheme';
import { runCreateCommand } from './starter';

const CONFIG = 'components.json';
const FILE_COUNT_MAX = 512;
const CONFIG_BYTES_MAX = 256 * 1024;
const MIGRATION_BYTES_MAX = 8 * 1024 * 1024;
const MIGRATION_DEPTH_MAX = 12;
const activeChanges = new Set<string>();
const CONCURRENT_CHANGES_MAX = 4;

interface SettingState {
  readonly enabled: boolean;
}

interface FileEdit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

interface ProjectConfig {
  readonly source: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly style: string;
  readonly ui: string;
  readonly css: string;
  readonly rtl: boolean;
}

export function readShadcnSettings(root: string): ShadcnSettingsReply {
  try {
    const config = readConfig(root);
    if (config === undefined) {
      return ok(undefined);
    }
    const style = readOptionalSource(root, cssFile(config));
    return ok({ rtl: config.rtl, pointer: style !== undefined && pointerDeclarations(postcss.parse(style)).at(-1)?.value === 'pointer' });
  } catch (error: unknown) {
    return failure(error);
  }
}

export async function changeShadcnSetting(root: string, change: Omit<ShadcnSettingsChange, 'projectPath'>): Promise<ShadcnSettingsReply> {
  try {
    if (activeChanges.has(root) || activeChanges.size >= CONCURRENT_CHANGES_MAX) {
      throw new Error('Wait for the current shadcn change to finish.');
    }
    activeChanges.add(root);
    try {
      const config = readConfig(root);
      if (config === undefined) {
        return ok(undefined);
      }
      const edits = change.setting === 'pointer' ? pointerEdit(root, config, change) : await rtlEdits(root, config, change);
      applyEdits(root, edits);
      return readShadcnSettings(root);
    } finally {
      activeChanges.delete(root);
    }
  } catch (error: unknown) {
    return failure(error);
  }
}

function readConfig(root: string): ProjectConfig | undefined {
  const source = readOptionalSource(root, CONFIG, { bytesMax: CONFIG_BYTES_MAX });
  if (source === undefined) {
    return undefined;
  }
  const value: unknown = JSON.parse(source);
  const data = toRecord(value);
  const style = data?.['style'];
  const ui = toRecord(data?.['aliases'])?.['ui'];
  const components = toRecord(data?.['aliases'])?.['components'];
  const css = toRecord(data?.['tailwind'])?.['css'];
  // A components.json belonging to another library can have a different schema.
  const schema = data?.['$schema'];
  if (schema !== undefined && schema !== 'https://ui.shadcn.com/schema.json') {
    return undefined;
  }
  if (data === undefined || typeof style !== 'string' || typeof css !== 'string') {
    return undefined;
  }
  const alias = typeof ui === 'string' ? ui : typeof components === 'string' ? components + '/ui' : undefined;
  if (alias === undefined) {
    return undefined;
  }
  return { source, data, style, ui: alias, css, rtl: data['rtl'] === true };
}

function cssFile(config: ProjectConfig): string {
  if (!config.css.endsWith('.css')) {
    throw new Error('The shadcn config must name a global CSS file.');
  }
  return config.css;
}

function pointerDeclarations(stylesheet: ReturnType<typeof postcss.parse>): readonly Declaration[] {
  const matches: Declaration[] = [];
  stylesheet.walkRules((rule) => {
    if (rule.parent?.type !== 'atrule' || rule.parent.name !== 'layer' || rule.parent.params !== 'base') {
      return;
    }
    const selectors = rule.selectors.map((selector) => selector.replaceAll(/["']/g, '').replaceAll(/\s/g, '')).sort();
    if (selectors.join(',') !== '[role=button]:not(:disabled),button:not(:disabled)') {
      return;
    }
    for (const node of rule.nodes) {
      if (node.type === 'decl' && node.prop === 'cursor') {
        matches.push(node);
      }
    }
  });
  return matches;
}

function pointerEdit(root: string, config: ProjectConfig, { enabled }: SettingState): readonly FileEdit[] {
  const file = cssFile(config);
  const before = readRequiredSource(root, file);
  const stylesheet = postcss.parse(before);
  const declarations = pointerDeclarations(stylesheet);
  if (enabled) {
    if (declarations.at(-1)?.value === 'pointer') {
      return [];
    }
    // Append a base-layer override so existing non-pointer rules still belong to the author.
    return [{ file, before, after: before + '\n@layer base {\n  button:not(:disabled), [role="button"]:not(:disabled) {\n    cursor: pointer;\n  }\n}\n' }];
  }
  for (const declaration of declarations) {
    if (declaration.value === 'pointer') {
      const rule = declaration.parent;
      declaration.remove();
      if (rule?.nodes?.length === 0) {
        const layer = rule.parent;
        rule.remove();
        if (layer?.nodes?.length === 0) {
          layer.remove();
        }
      }
    }
  }
  return [{ file, before, after: stylesheet.toString() }];
}

async function rtlEdits(root: string, config: ProjectConfig, { enabled }: SettingState): Promise<readonly FileEdit[]> {
  if (enabled === config.rtl) {
    return [];
  }
  const components = enabled ? await migrateComponents(root, config) : [];
  // Disabling affects future installs. Already converted logical CSS works in LTR.
  return [
    ...components,
    ...starterPreviewEdits(root, config, { enabled }),
    { file: CONFIG, before: config.source, after: JSON.stringify({ ...config.data, rtl: enabled }, undefined, 2) + '\n' },
  ];
}

function starterPreviewEdits(root: string, config: ProjectConfig, { enabled }: SettingState): readonly FileEdit[] {
  const base = SHADCN_BASES.find((candidate) => config.style.startsWith(candidate + '-'));
  if (base === undefined) {
    return [];
  }
  const candidates = [
    { file: 'src/layouts/main.astro', generate: shadcnStarterLayout },
    { file: 'src/components/examples/ThemePicker.tsx', generate: shadcnThemePicker },
  ];
  const edits = candidates.map(({ file, generate }) => ({
    file,
    before: generate(base, { rtl: config.rtl }),
    after: generate(base, { rtl: enabled }),
  }));
  // Both files must belong to the starter. Never replace a site's customized preview.
  return edits.every(({ file, before }) => readOptionalSource(root, file) === before) ? edits : [];
}

async function migrateComponents(root: string, config: ProjectConfig): Promise<readonly FileEdit[]> {
  const directory = uiDirectory(root, config.ui);
  const sources = snapshotComponents(root, directory);
  if (sources.length === 0) {
    return [];
  }
  // The shadcn CLI works on a disposable fixture. Only its transformations of captured
  // files are copied back, through Stacki's document actors with source checks.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-shadcn-rtl-'));
  try {
    const stagedUi = 'src/components/ui';
    fs.writeFileSync(
      path.join(scratch, CONFIG),
      JSON.stringify({
        ...config.data,
        tailwind: { ...toRecord(config.data['tailwind']), css: 'src/global.css', config: '' },
        aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui', lib: '@/lib', hooks: '@/hooks' },
        registries: {},
      }),
    );
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: 'stacki-shadcn-migration', dependencies: { astro: '*', tailwindcss: '*' } }));
    fs.writeFileSync(path.join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    fs.writeFileSync(path.join(scratch, 'astro.config.mjs'), 'export default {}\n');
    for (const { file, before } of sources) {
      const target = path.join(scratch, stagedUi, path.relative(directory, file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, before);
    }
    ensureToolPath();
    await runCreateCommand(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['exec', '--yes', '--', SHADCN_CLI_PACKAGE, 'migrate', 'rtl', '--yes'],
      scratch,
      undefined,
      { waitForStop: true, outputBytesMax: MAIN_LIMITS.commandOutputBytesMax },
    );
    const migrated = readConfig(scratch);
    if (migrated?.rtl !== true) {
      throw new Error('shadcn did not finish the RTL migration.');
    }
    return sources.map(({ file, before }) => ({ file, before, after: readRequiredSource(scratch, path.join(stagedUi, path.relative(directory, file))) }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function uiDirectory(root: string, alias: string): string {
  const config = readOptionalSource(root, 'tsconfig.json') ?? readOptionalSource(root, 'jsconfig.json');
  const parsed: unknown = config === undefined ? undefined : ts.parseConfigFileTextToJson('tsconfig.json', config).config;
  const compiler = toRecord(toRecord(parsed)?.['compilerOptions']);
  const base = compiler?.['baseUrl'];
  const paths = toRecord(compiler?.['paths']) ?? {};
  const matches = Object.entries(paths).sort(([first], [second]) => second.length - first.length);
  for (const [pattern, targets] of matches) {
    const wildcard = pattern.endsWith('*');
    if (wildcard ? !alias.startsWith(pattern.slice(0, -1)) : alias !== pattern) {
      continue;
    }
    if (Array.isArray(targets)) {
      for (const target of targets) {
        if (typeof target === 'string') {
          const suffix = wildcard ? alias.slice(pattern.length - 1) : '';
          const candidate = path.join(typeof base === 'string' ? base : '.', target.replace('*', suffix));
          if (projectEntry(root, candidate)?.stat.isDirectory()) {
            return candidate;
          }
        }
      }
    }
  }
  if (alias.startsWith('@/') || alias.startsWith('./')) {
    const relative = alias.slice(2);
    for (const candidate of [path.join('src', relative), relative]) {
      if (projectEntry(root, candidate)?.stat.isDirectory()) {
        return candidate;
      }
    }
  }
  throw new Error('Stacki could not locate the shadcn UI folder. Check the UI alias in components.json.');
}

function snapshotComponents(root: string, directory: string): readonly { readonly file: string; readonly before: string }[] {
  const queue = [{ folder: directory, depth: 0 }];
  const sources: { file: string; before: string }[] = [];
  let visited = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > MIGRATION_DEPTH_MAX) {
      throw new Error('The shadcn UI folder is too deeply nested to migrate.');
    }
    for (const entry of fs.readdirSync(path.join(root, current.folder), { withFileTypes: true })) {
      visited += 1;
      if (visited > FILE_COUNT_MAX) {
        throw new Error('The shadcn UI folder exceeds the migration file limit.');
      }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const file = path.join(current.folder, entry.name);
      if (entry.isDirectory()) {
        queue.push({ folder: file, depth: current.depth + 1 });
      } else if (/\.[jt]sx?$/.test(entry.name)) {
        const before = readRequiredSource(root, file);
        bytes += Buffer.byteLength(before);
        if (bytes > MIGRATION_BYTES_MAX) {
          throw new Error('The shadcn UI source exceeds the migration size limit.');
        }
        sources.push({ file, before });
      }
    }
  }
  return sources;
}

function applyEdits(root: string, proposed: readonly FileEdit[]): void {
  const edits = proposed.filter(({ before, after }) => before !== after);
  for (const { file, before } of edits) {
    if (readRequiredSource(root, file) !== before) {
      throw new Error('A shadcn file changed during this operation. Try again.');
    }
  }
  const written: FileEdit[] = [];
  try {
    for (const edit of edits) {
      writeProjectText(path.join(root, edit.file), edit.after, edit.before);
      written.push(edit);
    }
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = [];
    for (const edit of written.reverse()) {
      try {
        writeProjectText(path.join(root, edit.file), edit.before, edit.after);
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'A shadcn file changed while restoring the project. Review the project files before trying again.');
    }
    throw error;
  }
}

function readRequiredSource(root: string, file: string): string {
  const source = readOptionalSource(root, file);
  if (source === undefined) {
    throw new Error('A shadcn project file could not be found: ' + file);
  }
  return source;
}

function readOptionalSource(root: string, file: string, options?: { readonly bytesMax: number }): string | undefined {
  const entry = projectEntry(root, file);
  if (entry?.stat.isFile() !== true) {
    return undefined;
  }
  if (options !== undefined && entry.stat.size > options.bytesMax) {
    throw new Error('The shadcn config exceeds the file size limit.');
  }
  const source = readSource(entry.absolute);
  if (options !== undefined && Buffer.byteLength(source) > options.bytesMax) {
    throw new Error('The shadcn config exceeds the file size limit.');
  }
  return source;
}

function projectEntry(root: string, file: string): { readonly absolute: string; readonly stat: fs.Stats } | undefined {
  if (file.length > BOUNDARY_LIMITS.pathLengthMax) {
    throw new Error('A shadcn project path exceeds the path limit.');
  }
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('shadcn project files must be inside the project.');
  }
  // Walk each ancestor so even an in-project symlink cannot redirect a write.
  let entry = root;
  for (const segment of relative.split(path.sep)) {
    entry = path.join(entry, segment);
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (stat === undefined) {
      return undefined;
    }
    if (stat.isSymbolicLink()) {
      throw new Error('Stacki cannot change shadcn files through a symlink.');
    }
    if (entry === absolute) {
      return { absolute, stat };
    }
  }
  return undefined;
}

function failure(error: unknown): ShadcnSettingsReply {
  return err({ message: error instanceof Error ? error.message : String(error) });
}
