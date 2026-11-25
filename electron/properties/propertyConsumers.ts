// Resolve identity before editing: a tag name alone cannot identify a component.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { refusal } from '../../shared/properties/propertyErrors';
import type { MessageKey } from '../../shared/properties/i18n/messageRef';
import { err, ok, type Result } from '../../shared/core/result';
import { aliasMap, resolveSpec, type Alias } from '../content/cmsRefs';
import { importsOf } from './componentUsage';
import { sameFilesystemPath } from '../lib/platform';
import { readPropertySyntax, syntaxNodes } from './propertySyntax';

export interface PropertyConsumer {
  readonly file: string;
  readonly source: string;
  readonly names: ReadonlySet<string>;
}
export function readPropertyConsumers(location: { readonly projectPath: string; readonly file: string }): Result<readonly PropertyConsumer[]> {
  const files = projectSources(location.projectPath);
  if (!files.ok) {
    return files;
  }
  const aliases = aliasMap(location.projectPath);
  const consumers: PropertyConsumer[] = [];
  let total = 0;
  for (const file of files.value) {
    const read = readBoundedSource(file);
    if (!read.ok) {
      return read;
    }
    total += read.value.length;
    if (total > PROPERTY_LIMITS.totalCharsMax) {
      return err(refusal('limit', 'props.rename.sourceLimit'));
    }
    const names = readConsumerNames(read.value, file, location.file, aliases);
    if (!names.ok) {
      return names;
    }
    if (names.value.size > 0 || sameFilesystemPath(file, location.file)) {
      consumers.push({ file, source: read.value, names: names.value });
    }
  }
  assert(consumers.length <= PROPERTY_LIMITS.filesMax, 'Consumer collection is bounded');
  assert(
    consumers.some((consumer) => sameFilesystemPath(consumer.file, location.file)),
    'The component is included among project sources',
  );
  return ok(consumers);
}
export function readBoundedSource(file: string): Result<string> {
  try {
    if (fs.statSync(file).size > PROPERTY_LIMITS.sourceCharsMax) {
      return err(refusal('limit', 'props.rename.fileTooLarge', { file }));
    }
    return ok(fs.readFileSync(file, 'utf8'));
  } catch (error: unknown) {
    return filesystemError(error);
  }
}
export function filesystemError(error: unknown): Result<never> {
  return err({
    code: 'filesystem',
    message: error instanceof Error ? error.message : String(error),
  });
}

function readConsumerNames(source: string, file: string, target: string, aliases: readonly Alias[]): Result<ReadonlySet<string>> {
  const names = new Set(
    importsOf(source, file, aliases)
      .filter((entry) => [...entry.candidates].some((candidate) => sameFilesystemPath(candidate, target)))
      .flatMap((entry) => entry.names),
  );
  const syntax = file.endsWith('.astro')
    ? readPropertySyntax(source).syntax
    : ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const resolves = (specifier: string): boolean => resolveSpec(specifier, file, aliases).some((candidate) => sameFilesystemPath(candidate, target));
  for (const statement of syntax.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolves(statement.moduleSpecifier.text)
    ) {
      return unsupportedConsumer(file, 'props.rename.consumerReExport');
    }
    if (ts.isImportDeclaration(statement)) {
      continue;
    }
    if (syntaxNodes(statement).some((node) => ts.isIdentifier(node) && names.has(node.text))) {
      // Runtime aliases and ComponentProps type queries need a semantic project refactor.
      // Refuse them rather than silently leave a second API spelling behind.
      if (!file.endsWith('.mdx')) {
        return unsupportedConsumer(file, 'props.rename.consumerUsesInCode');
      }
    }
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1] && resolves(match[1])) {
      return unsupportedConsumer(file, 'props.rename.consumerDynamicImport');
    }
  }
  const layout = /^layout:\s*["']?([^\s"']+)/m.exec(source)?.[1];
  if (/\.mdx?$/.test(file) && layout && resolves(layout)) {
    return unsupportedConsumer(file, 'props.rename.consumerLayout');
  }
  if (names.size > 0 && !/\.(astro|mdx)$/.test(file)) {
    return unsupportedConsumer(file, 'props.rename.consumerOutsideAstro');
  }
  return ok(names);
}
function unsupportedConsumer(file: string, key: MessageKey): Result<never> {
  return err(refusal('consumer', key, { file }));
}

export function projectSources(projectPath: string): Result<readonly string[]> {
  const pending = [path.join(projectPath, 'src')];
  const files: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index];
    assert(directory !== undefined, 'Queued directory exists');
    const entries = readDirectory(directory);
    if (!entries.ok) {
      return entries;
    }
    for (const entry of entries.value) {
      if (entry.isSymbolicLink()) {
        return err(refusal('symlink', 'props.rename.symlink'));
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.(astro|mdx?|jsx?|tsx?|svelte|vue)$/.test(entry.name)) {
        files.push(full);
      }
      if (pending.length + files.length > PROPERTY_LIMITS.filesMax) {
        return err(refusal('limit', 'props.rename.fileLimit'));
      }
    }
  }
  return ok(files);
}
function readDirectory(directory: string): Result<readonly fs.Dirent[]> {
  try {
    return ok(fs.readdirSync(directory, { withFileTypes: true }));
  } catch (error: unknown) {
    return filesystemError(error);
  }
}
