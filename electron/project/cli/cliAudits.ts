// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `stacki audits list|presets|add|update|remove|test`: the project's custom audits (`.stacki/audits.json` customAudits) from the
// command line and the MCP server, for people and AI agents alike.
//
// Why no rule lives here: what a custom audit may hold is `parseCustomAudit`, whether a pattern is safe to run is `checkPattern`
// (through `compileCustomAudit`), and what a match is is `scanCustomFiles` (shared/page/auditCustom.ts): the same functions the
// Audits panel's editor and its runner call. A write is an ordinary settings edit of `.stacki/audits.json`, serialised by the
// app's own `serializeAuditIgnores`, so the plan, the atomic apply, the lock, the role check and `stacki undo` are the runner's.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { scanCustomFiles } from '../../../shared/page/auditCustom';
import { parseAuditIgnoresSource, serializeAuditIgnores, type AuditFile } from '../../../shared/properties/auditIgnores';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { fileSchemaById } from '../../../shared/properties/cli/stackiFiles';
import {
  CUSTOM_AUDIT_LIMITS,
  CUSTOM_AUDIT_PRESETS,
  compileCustomAudit,
  customAuditCategoryOf,
  customAuditIdFor,
  customAuditPreset,
  parseCustomAudit,
  serializedCustomAudits,
  withCustomAudit,
  withoutCustomAudit,
  type CustomAudit,
} from '../../../shared/properties/customAudits';
import type { CommandContext, Handler, Outcome } from './cliCommands';
import type { Edit } from './cliPlan';
import { readFileState } from './cliFiles';

/** Bounds of the project walk `audits test` reads. */
export const AUDIT_CLI_LIMITS = {
  filesMax: 2_000,
  charsMax: 40_000_000,
  depthMax: 16,
  samplesMax: 50,
  samplesDefault: 10,
} as const satisfies Record<string, number>;

export const AUDIT_HANDLERS: Readonly<Record<string, Handler>> = {
  'audits list': auditsList,
  'audits presets': auditsPresets,
  'audits add': auditsAdd,
  'audits update': auditsUpdate,
  'audits remove': auditsRemove,
  'audits test': auditsTest,
};

const refused = (message: string, code: CliError['code'] = 'invalid-value'): Result<never, CliError> => err({ code, message });

/** A string flag as given, or undefined when absent (an empty string counts as given, so `--exclude ""` clears it on update). */
function given(context: CommandContext, name: string): string | undefined {
  const value = context.args[name];
  return typeof value === 'string' ? value : undefined;
}

function readAudits(root: string): Result<AuditFile, CliError> {
  const schema = fileSchemaById('audits');
  if (schema === undefined) {
    return refused('The audits registry is missing.', 'internal');
  }
  const state = readFileState(root, schema);
  if (!state.ok) {
    return state;
  }
  try {
    return ok(parseAuditIgnoresSource(state.value.source));
  } catch (error: unknown) {
    return refused(`.stacki/audits.json does not read: ${error instanceof Error ? error.message : String(error)}`, 'invalid-file');
  }
}

/** The plain-JSON view of an audit, as the file writes it plus whether its patterns pass the guard today. */
function describedAudit(audit: CustomAudit): Record<string, unknown> {
  const [written] = serializedCustomAudits([audit]);
  const compiled = compileCustomAudit(audit);
  return { ...written, severity: audit.severity, safe: compiled.ok, ...(compiled.ok ? {} : { problem: compiled.error.message }) };
}

function auditsList(context: CommandContext): Result<Outcome, CliError> {
  const file = readAudits(context.root);
  if (!file.ok) {
    return file;
  }
  const audits = file.value.customAudits;
  return ok({
    kind: 'read',
    summary: audits.length === 0 ? 'No custom audits yet; "stacki audits presets" lists starting points.' : `${audits.length} custom audits.`,
    result: { audits: audits.map(describedAudit), limit: CUSTOM_AUDIT_LIMITS.auditsMax },
  });
}

function auditsPresets(): Result<Outcome, CliError> {
  return ok({
    kind: 'read',
    summary: `${CUSTOM_AUDIT_PRESETS.length} presets; add one with "stacki audits add --preset <id>".`,
    result: {
      presets: CUSTOM_AUDIT_PRESETS.map((preset) => ({ preset: preset.preset, ...describedAudit({ ...preset.audit, id: preset.preset, enabled: true }) })),
    },
  });
}

// The audit the flags describe, laid over `base` (a preset, the saved audit, or nothing), as raw JSON the app's parser then judges.
function withFlags(context: CommandContext, base: Record<string, unknown>): Result<Record<string, unknown>, CliError> {
  const next: Record<string, unknown> = { ...base };
  for (const name of ['name', 'icon', 'severity']) {
    const value = given(context, name);
    if (value !== undefined) {
      next[name] = value;
    }
  }
  const message = given(context, 'message');
  if (message !== undefined) {
    next['message'] = message.length === 0 ? undefined : message;
  }
  const category = given(context, 'category');
  if (category !== undefined) {
    next['category'] = customAuditCategoryOf(category);
  }
  const exclude = given(context, 'exclude');
  if (exclude !== undefined) {
    next['exclude'] = exclude.length === 0 ? undefined : exclude;
  }
  const enabled = context.args['enabled'];
  if (typeof enabled === 'boolean') {
    next['enabled'] = enabled;
  }
  const scope = given(context, 'scope') ?? (typeof base['scope'] === 'string' ? base['scope'] : 'declaration');
  // A flag the scope does not read is refused: dropped quietly, the command would report a change it did not make.
  const unused = (scope === 'declaration' ? ['regex'] : ['property', 'valueMustMatch', 'valueMustNotMatch']).find((name) => given(context, name) !== undefined);
  if (unused !== undefined) {
    const flag = unused.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const instead = scope === 'declaration' ? '--property and --value-must-match' : '--regex';
    return refused(`--${flag} does not apply to a ${scope} audit; it takes ${instead}. Nothing was written.`);
  }
  const baseMatch = typeof base['match'] === 'object' && base['match'] !== null && base['scope'] === scope ? base['match'] : {};
  const match: Record<string, unknown> = { ...baseMatch };
  if (scope === 'declaration') {
    for (const name of ['property', 'valueMustMatch', 'valueMustNotMatch']) {
      const value = given(context, name);
      if (value !== undefined) {
        match[name] = value.length === 0 ? undefined : value;
      }
    }
  } else {
    const regex = given(context, 'regex');
    if (regex !== undefined) {
      match['pattern'] = regex;
    }
  }
  next['scope'] = scope;
  next['match'] = match;
  return ok(next);
}

// Checks what the flags made: the app's parser for its shape and bounds, then the guard for every pattern. Designer- and
// agent-friendly: each refusal names the flag to change.
function checkedAudit(raw: Record<string, unknown>): Result<CustomAudit, CliError> {
  let audit: CustomAudit;
  try {
    audit = parseCustomAudit(raw, 'audit');
  } catch (error: unknown) {
    return refused(flagWords(error instanceof Error ? error.message : String(error)));
  }
  const compiled = compileCustomAudit(audit);
  if (!compiled.ok) {
    return refused(`${flagWords(compiled.error.message)} Nothing was written.`);
  }
  return ok(audit);
}

// The parser's field paths (`audit.match.valueMustNotMatch`) said as the flags a person types (`--value-must-not-match`).
function flagWords(message: string): string {
  const flags: Readonly<Record<string, string>> = { pattern: 'regex' };
  return message
    .replace(/^audit\.(?:match\.)?(\w+)/, (_whole, field: string) => `--${(flags[field] ?? field).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
    .replace(
      /^(property|valueMustMatch|valueMustNotMatch|pattern|exclude):/,
      (_whole, field: string) => `--${(flags[field] ?? field).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:`,
    );
}

function auditsEdit(change: (file: AuditFile) => Result<AuditFile, CliError>): Result<Edit, CliError> {
  const schema = fileSchemaById('audits');
  if (schema === undefined) {
    return refused('The audits registry is missing.', 'internal');
  }
  return ok({
    schema,
    produce: (state) => {
      let file: AuditFile;
      try {
        file = parseAuditIgnoresSource(state.source);
      } catch (error: unknown) {
        return refused(`.stacki/audits.json does not read: ${error instanceof Error ? error.message : String(error)}`, 'invalid-file');
      }
      const next = change(file);
      return next.ok ? ok(serializeAuditIgnores(next.value)) : next;
    },
  });
}

function auditsAdd(context: CommandContext): Result<Outcome, CliError> {
  const file = readAudits(context.root);
  if (!file.ok) {
    return file;
  }
  const presetId = given(context, 'preset');
  const preset = presetId === undefined ? undefined : customAuditPreset(presetId);
  if (presetId !== undefined && preset === undefined) {
    return refused(`"${presetId}" is not a preset (${CUSTOM_AUDIT_PRESETS.map((entry) => entry.preset).join(', ')}).`, 'missing');
  }
  if (file.value.customAudits.length >= CUSTOM_AUDIT_LIMITS.auditsMax) {
    return refused(`A project has at most ${CUSTOM_AUDIT_LIMITS.auditsMax} custom audits; remove one first.`, 'refused');
  }
  const base =
    preset === undefined ? { icon: 'star', category: 'tokens' } : (serializedCustomAudits([{ ...preset.audit, id: preset.preset, enabled: true }])[0] ?? {});
  const flagged = withFlags(context, base);
  if (!flagged.ok) {
    return flagged;
  }
  const raw = flagged.value;
  const taken = file.value.customAudits.map((audit) => audit.id);
  const wanted = given(context, 'id');
  if (wanted !== undefined && taken.includes(wanted)) {
    return refused(`There is already a custom audit "${wanted}"; use "stacki audits update ${wanted}".`, 'exists');
  }
  if (typeof raw['name'] !== 'string' || raw['name'].trim().length === 0) {
    return refused('Name the audit: --name "Hard-coded text-align" (or start from --preset).', 'required');
  }
  const audit = checkedAudit({ ...raw, id: wanted ?? customAuditIdFor(raw['name'], taken), enabled: raw['enabled'] ?? true });
  if (!audit.ok) {
    return audit;
  }
  const added = audit.value;
  // The edit runs again on the file as staged, so a file that changed since this read is judged as it is then.
  const edit = auditsEdit((current) =>
    current.customAudits.some((entry) => entry.id === added.id)
      ? refused(`There is already a custom audit "${added.id}".`, 'exists')
      : ok({ ...current, customAudits: withCustomAudit(current.customAudits, added) }),
  );
  if (!edit.ok) {
    return edit;
  }
  return ok({
    kind: 'write',
    edits: [edit.value],
    summary: `Add custom audit "${added.name}" (${added.id}) to .stacki/audits.json.`,
    notes: [`The Audits panel runs it on its next audit; "stacki audits test ${added.id}" counts its matches now.`],
    result: { audit: describedAudit(added) },
  });
}

function auditsUpdate(context: CommandContext): Result<Outcome, CliError> {
  const id = given(context, 'id') ?? '';
  const file = readAudits(context.root);
  if (!file.ok) {
    return file;
  }
  const current = file.value.customAudits.find((audit) => audit.id === id);
  if (current === undefined) {
    return refused(`There is no custom audit "${id}" (ids: ${file.value.customAudits.map((audit) => audit.id).join(', ') || 'none'}).`, 'missing');
  }
  const [written] = serializedCustomAudits([current]);
  const flagged = withFlags(context, { ...written });
  if (!flagged.ok) {
    return flagged;
  }
  const audit = checkedAudit({ ...flagged.value, id });
  if (!audit.ok) {
    return audit;
  }
  const updated = audit.value;
  const edit = auditsEdit((staged) =>
    staged.customAudits.some((entry) => entry.id === id)
      ? ok({ ...staged, customAudits: withCustomAudit(staged.customAudits, updated) })
      : refused(`There is no custom audit "${id}".`, 'missing'),
  );
  if (!edit.ok) {
    return edit;
  }
  return ok({ kind: 'write', edits: [edit.value], summary: `Update custom audit ${id}.`, result: { audit: describedAudit(updated) } });
}

function auditsRemove(context: CommandContext): Result<Outcome, CliError> {
  const id = given(context, 'id') ?? '';
  const edit = auditsEdit((file) =>
    file.customAudits.some((audit) => audit.id === id)
      ? ok({ ...file, customAudits: withoutCustomAudit(file.customAudits, id) })
      : refused(`There is no custom audit "${id}".`, 'missing'),
  );
  return edit.ok ? ok({ kind: 'write', edits: [edit.value], summary: `Remove custom audit ${id}.` }) : edit;
}

function auditsTest(context: CommandContext): Result<Outcome, CliError> {
  const file = readAudits(context.root);
  if (!file.ok) {
    return file;
  }
  const id = given(context, 'id');
  let audit: CustomAudit;
  if (id !== undefined && id.length > 0) {
    const saved = file.value.customAudits.find((entry) => entry.id === id);
    if (saved === undefined) {
      return refused(`There is no custom audit "${id}" (ids: ${file.value.customAudits.map((entry) => entry.id).join(', ') || 'none'}).`, 'missing');
    }
    audit = saved;
  } else {
    const presetId = given(context, 'preset');
    const preset = presetId === undefined ? undefined : customAuditPreset(presetId);
    if (presetId !== undefined && preset === undefined) {
      return refused(`"${presetId}" is not a preset.`, 'missing');
    }
    const base =
      preset === undefined
        ? { id: 'inline', name: 'Inline audit', icon: 'star', category: 'tokens' }
        : (serializedCustomAudits([{ ...preset.audit, id: preset.preset, enabled: true }])[0] ?? {});
    const flagged = withFlags(context, base);
    if (!flagged.ok) {
      return flagged;
    }
    const checked = checkedAudit({ ...flagged.value, enabled: true });
    if (!checked.ok) {
      return checked;
    }
    audit = checked.value;
  }
  const compiled = compileCustomAudit(audit);
  if (!compiled.ok) {
    return refused(`${flagWords(compiled.error.message)} Fix it with "stacki audits update ${audit.id}".`);
  }
  if (compiled.value.scope === 'rendered') {
    return refused('A rendered audit reads the pages the dev server serves; the Audits panel runs it while the dev server runs.', 'refused');
  }
  const samplesMax = Math.min(
    AUDIT_CLI_LIMITS.samplesMax,
    Math.max(0, typeof context.args['samples'] === 'number' ? context.args['samples'] : AUDIT_CLI_LIMITS.samplesDefault),
  );
  const walk = projectSources(context.root);
  const scan = scanCustomFiles(walk.files, compiled.value, { samplesMax, startedMs: performance.now() }, () => performance.now());
  const more = scan.stopped !== 'complete' || walk.partial;
  return ok({
    kind: 'read',
    summary: `${audit.name}: ${scan.count}${more ? '+' : ''} matches in ${scan.files} files.`,
    result: { audit: describedAudit(audit), count: scan.count, files: scan.files, stopped: walk.partial ? 'file-limit' : scan.stopped, matches: scan.samples },
    ...(more ? { notes: ['The scan stopped at a bound (files, matches or time): there may be more matches.'] } : {}),
  });
}

/** The project's .astro files and stylesheets, read for `audits test`: generated and dependency folders skipped, symbolic links not followed, bounded. */
function projectSources(root: string): { readonly files: readonly { readonly file: string; readonly source: string }[]; readonly partial: boolean } {
  const files: { file: string; source: string }[] = [];
  let chars = 0;
  let partial = false;
  const skipped = new Set(['node_modules', 'dist', '.astro', '.stacki', '.git', '.vercel', '.netlify', '.output']);
  const pending: { readonly directory: string; readonly depth: number }[] = [{ directory: '', depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    assert(next !== undefined, 'projectSources: a pending folder');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, next.directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      const relative = next.directory === '' ? entry.name : `${next.directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name) && next.depth < AUDIT_CLI_LIMITS.depthMax) {
          pending.push({ directory: relative, depth: next.depth + 1 });
        }
      } else if (entry.isFile() && /\.(astro|css|scss|sass|less|pcss)$/i.test(entry.name)) {
        if (files.length >= AUDIT_CLI_LIMITS.filesMax) {
          return { files, partial: true };
        }
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        if (chars + source.length > AUDIT_CLI_LIMITS.charsMax) {
          partial = true;
          continue;
        }
        chars += source.length;
        files.push({ file: relative, source });
      }
    }
  }
  assert(files.length <= AUDIT_CLI_LIMITS.filesMax, 'projectSources: bounded');
  return { files: files.sort((left, right) => left.file.localeCompare(right.file)), partial };
}
