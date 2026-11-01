// Goal: pin the policy every agent harness enforces (scripts/agent/) and the
// commit-message rule the git hook enforces (scripts/policy/commitMessage.mts).
// Method: the verdicts are pure functions of a command or a path, so each is
// fed the positive space it must allow and the negative space it must refuse,
// including the spellings an agent could reach for to get around a rule —
// flag clusters, global options, quoting, chained commands, absolute paths.
// The hook payload parser gets each known-bad shape. Last, the Claude Code and
// Codex entry points run as child processes on recorded payloads, pinning the
// exact protocol each harness reads (decision JSON, exit codes).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { commandSegments, commandVerdict, pathVerdict, patchPaths, repositoryPath, tokenize, writeUnits } from '../../../scripts/agent/core.mts';
import { parseHookPayload } from '../../../scripts/agent/payload.mts';
import { decideStop, parseStopState, reportDigest } from '../../../scripts/agent/stopState.mts';
import { commitMessageProblems } from '../../../scripts/policy/commitMessage.mts';

// The runner starts every suite at the repository root.
const ROOT = process.cwd();

function verdictOf(command: string): string {
  return commandVerdict(command, ROOT).kind;
}

test('commands that skip the hooks are refused', () => {
  const refused = [
    'git commit --no-verify -m "x"',
    'git commit -n -m x',
    'git commit -anm wip',
    'git -C . commit -n -m x',
    'git push --no-verify',
    'git merge --no-verify main',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git config core.hooksPath /tmp/none',
    'git config --unset core.hooksPath',
    'git add -A && git commit --no-verify -m x',
    'npm test; git commit -n',
    '(cd src && git commit --no-verify)',
    'cp evil .git/hooks/pre-commit',
  ];
  for (const command of refused) {
    assert.equal(verdictOf(command), 'deny', command);
  }
});

test('ordinary commands, including ones that mention the flags, are allowed', () => {
  const allowed = [
    'git commit -m "use -n to skip"',
    'git commit -m "--no-verify is refused"',
    'git commit -mnote',
    'git log -n 5',
    'git config --get core.hooksPath',
    'git config core.hooksPath',
    'git push origin main',
    'npm test',
    'cat eslint.config.mjs',
    'grep -n rule scripts/policy/scan.mts',
  ];
  for (const command of allowed) {
    assert.equal(verdictOf(command), 'allow', command);
  }
});

test('shell writes to gate files ask a human; shell writes elsewhere do not', () => {
  const asked = [
    'echo x > eslint.config.mjs',
    "sed -i 's/error/off/' eslint.config.mjs",
    'rm scripts/policy/scan.mts',
    `python3 - <<'EOF'\nopen('AGENTS.md','w')\nEOF`,
    `tee ${ROOT}/.claude/settings.json < new.json`,
    'git checkout -- tsconfig.json',
  ];
  for (const command of asked) {
    assert.equal(verdictOf(command), 'ask', command);
  }
  assert.equal(verdictOf('echo x > src/notes.txt'), 'allow');
  assert.equal(verdictOf('node_modules/.bin/eslint eslint.config.mjs 2>&1'), 'allow');
});

test('a command line that writes elsewhere and only reads a gate file is allowed', () => {
  // Both were asked before the write check was scoped to one command.
  const allowed = [
    "sed -i '' 's/a/b/' electron/content/astroSchemaEdit.ts && " + 'npx tsc --noEmit -p tsconfig.json 2>&1 | head -30; ls tsconfig*.json',
    `python3 - <<'EOF'\np='electron/project/styleFiles.ts'\n# A site's stylesheets.\n` +
      `open(p,'w').write('x')\nEOF\nnpx tsc --noEmit -p electron/tsconfig.json`,
    'cp a.ts b.ts; cat eslint.config.mjs',
    'cd /tmp && rm notes.txt',
  ];
  for (const command of allowed) {
    assert.equal(verdictOf(command), 'allow', command);
  }
});

test('a write stays asked when a pipeline, subshell, cd, or heredoc carries the gate file', () => {
  const asked = [
    'ls tsconfig*.json | xargs rm',
    'echo x > $(echo tsconfig.json)',
    '(cd scripts && rm agent/core.mts)',
    'cd scripts/agent && sed -i s/a/b/ core.mts',
    `cd ${ROOT}/scripts && rm policy/scan.mts`,
    `npm test && python3 - <<'EOF'\nopen('eslint.config.mjs','w')\nEOF`,
    `cat <<-EOF > AGENTS.md\n\tx\n\tEOF`,
  ];
  for (const command of asked) {
    assert.equal(verdictOf(command), 'ask', command);
  }
});

test('writeUnits keeps heredoc bodies, pipelines, and subshells whole', () => {
  assert.deepEqual(writeUnits('a && b || c; d\ne'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(writeUnits('a | b && (c; d) && `e; f`'), ['a | b', '(c; d)', '`e; f`']);
  assert.deepEqual(writeUnits("a 'x; y' && b"), ["a 'x; y'", 'b']);
  assert.deepEqual(writeUnits(`py <<'EOF'\nit's; a\nEOF\nb`), [`py <<'EOF'\nit's; a\nEOF`, 'b']);
  assert.deepEqual(writeUnits('cat <<<"a; b" && c'), ['cat <<<"a; b"', 'c']);
  // A heredoc that never ends runs to the end of the command line.
  assert.deepEqual(writeUnits('py <<EOF\na; b'), ['py <<EOF\na; b']);
});

test('edits to the files that define the gates ask a human', () => {
  const gates = [
    'AGENTS.md',
    'CLAUDE.md',
    'eslint.config.mjs',
    'tsconfig.json',
    'electron/tsconfig.preload.json',
    'scripts/eslintPlugin/naming.mts',
    'scripts/policy/limits.mts',
    'scripts/agent/core.mts',
    '.githooks/pre-commit',
    '.claude/settings.json',
    '.codex/hooks.json',
    '.pi/extensions/stacki-policy/index.ts',
    '.github/workflows/check.yml',
    'shared/core/limits.ts',
    // The bounds stay protected in a shared/ area folder, where the restructure moves them.
    'shared/core/limits.ts',
  ];
  for (const file of gates) {
    assert.equal(pathVerdict(file).kind, 'ask', file);
  }
  const allowed = [
    'src/Sample.tsx',
    'shared/page/pageNode.ts',
    'shared/core/limitsOfText.ts',
    'shared/core/deeper/limits.ts',
    'scripts/release/release.ts',
    'README.md',
  ];
  for (const file of allowed) {
    assert.equal(pathVerdict(file).kind, 'allow', file);
  }
  assert.equal(pathVerdict('.git/config').kind, 'deny');
});

test('path verdicts assert their precondition: repository-relative, forward slashes', () => {
  assert.throws(() => pathVerdict('/abs/path'), /Assertion failed: pathVerdict: paths are/);
  assert.throws(() => pathVerdict('src\\App.tsx'), /Assertion failed: pathVerdict: paths use/);
});

test('repository paths: inside is relative, outside is absent', () => {
  assert.equal(repositoryPath(ROOT, ROOT, path.join(ROOT, 'src', 'Sample.tsx')), 'src/Sample.tsx');
  assert.equal(repositoryPath(ROOT, path.join(ROOT, 'src'), 'Sample.tsx'), 'src/Sample.tsx');
  assert.equal(repositoryPath(ROOT, ROOT, '/etc/passwd'), undefined);
  assert.equal(repositoryPath(ROOT, ROOT, '../elsewhere.ts'), undefined);
});

test('command lines split at operators, never inside quotes', () => {
  assert.deepEqual(commandSegments('a && b; c | d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(commandSegments('git commit -m "a; b && c"'), ['git commit -m "a; b && c"']);
  assert.deepEqual(tokenize(`git commit -m "a b" 'c d'`), ['git', 'commit', '-m', 'a b', 'c d']);
  assert.deepEqual(tokenize('x ""'), ['x', '']);
});

test('patch paths are read from every header form, wherever the patch sits', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '*** Move to: src/b.ts',
    '*** Add File: src/c.ts',
    '*** Delete File: src/d.ts',
    '*** End Patch',
  ].join('\n');
  const expected = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  assert.deepEqual([...patchPaths({ command: patch })].sort(), expected);
  assert.deepEqual([...patchPaths({ input: [patch] })].sort(), expected);
  assert.deepEqual(patchPaths({ command: 'ls' }), []);
});

test('hook payloads: known-good parses; each known-bad shape fails', () => {
  const good = parseHookPayload(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'abc-123',
      cwd: ROOT,
      tool_name: 'Edit',
      tool_input: { file_path: 'src/Sample.tsx' },
    }),
    'pre-tool',
  );
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.deepEqual(good.value.paths, ['src/Sample.tsx']);
    assert.equal(good.value.command, undefined);
  }
  const bad: readonly [string, string][] = [
    ['not json', 'is not JSON'],
    ['[]', 'is not a JSON object'],
    ['null', 'is not a JSON object'],
    [JSON.stringify({ hook_event_name: 'Stop' }), 'configured for PreToolUse, received Stop'],
    [JSON.stringify({ session_id: '../../etc' }), 'session_id has an unexpected shape'],
  ];
  for (const [raw, message] of bad) {
    const parsed = parseHookPayload(raw, 'pre-tool');
    assert.equal(parsed.ok, false, raw);
    if (!parsed.ok) {
      assert.match(parsed.error, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});

test('commit messages: typed subject, length, separator, body', () => {
  const good = 'fix(parser): keep boundary spaces\n\nThe serializer trimmed them.\n';
  assert.deepEqual(commitMessageProblems(good), []);
  // Generated messages pass as git and the release script write them.
  for (const generated of ['Merge branch main', 'v0.1.35', 'fixup! fix(x): y', 'Revert "x"']) {
    assert.deepEqual(commitMessageProblems(generated), [], generated);
  }
  // Comment lines and the verbose diff below the scissors are not the message.
  const scissors = '# ------------------------ >8 ------------------------';
  const withComments = `${good}# Please enter the commit message\n${scissors}\ndiff`;
  assert.deepEqual(commitMessageProblems(withComments), []);
  const kinds = (message: string): readonly string[] => commitMessageProblems(message).map((problem) => problem.kind);
  assert.deepEqual(kinds(''), ['empty']);
  assert.deepEqual(kinds('wip'), ['subject-format', 'body-missing']);
  assert.deepEqual(kinds('fix: x'), ['body-missing']);
  assert.deepEqual(kinds('fix: x\nbody right away'), ['separator']);
  assert.deepEqual(kinds(`fix: ${'x'.repeat(68)}\n\nBody.`), ['subject-length']);
  assert.deepEqual(kinds(`fix: ${'x'.repeat(67)}\n\nBody.`), []);
});

test('stop refusals are bounded per set of findings', () => {
  const findings = reportDigest('src/a.ts: 1 warning');
  const changed = reportDigest('src/a.ts: 2 warnings');
  let state = parseStopState(undefined);
  const kinds: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const decision = decideStop(state, findings, 3);
    kinds.push(decision.kind);
    state = decision.next;
  }
  // Three refusals, one release, then the same findings pass without a new round.
  assert.deepEqual(kinds, ['refuse', 'refuse', 'refuse', 'release', 'already-released']);
  // Different findings after a release start a fresh round at attempt 1.
  const fresh = decideStop(state, changed, 3);
  assert.equal(fresh.kind, 'refuse');
  if (fresh.kind === 'refuse') {
    assert.equal(fresh.attempt, 1);
  }
  assert.throws(() => decideStop(state, 'not-a-digest', 3), /Assertion failed: decideStop/);
});

test('stored stop state parses; every malformed shape reads as empty', () => {
  const digest = reportDigest('x');
  assert.deepEqual(parseStopState({ refusals: 2, releasedDigest: digest }), {
    refusals: 2,
    releasedDigest: digest,
  });
  const empty = { refusals: 0, releasedDigest: undefined };
  // A stored file can hold JSON null; it arrives the way the reader sees it.
  const storedNull: unknown = JSON.parse('null');
  for (const bad of [storedNull, 'x', { refusals: -1 }, { refusals: 1.5 }, { refusals: 10_000 }]) {
    assert.deepEqual(parseStopState(bad), empty, JSON.stringify(bad));
  }
  assert.deepEqual(parseStopState({ refusals: 1, releasedDigest: 'short' }), {
    refusals: 1,
    releasedDigest: undefined,
  });
});

// The protocol each harness reads, pinned end to end on a child process.
function runEntry(
  entry: string,
  event: string,
  payload: object,
): {
  readonly status: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
} {
  const script = path.join(ROOT, 'scripts', 'agent', entry);
  const result = spawnSync(process.execPath, [script, event], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, STACKI_ALLOW_POLICY_EDITS: '' },
  });
  // spawnSync reports "no exit code" (a signal) as null; absence is undefined here.
  const status = result.status ?? undefined;
  return { status, stdout: result.stdout, stderr: result.stderr };
}

test('Claude Code: refusals and asks are PreToolUse decisions; allows are silent', () => {
  const bash = (command: string): object => ({
    hook_event_name: 'PreToolUse',
    session_id: 's',
    tool_name: 'Bash',
    tool_input: { command },
  });
  const denied = runEntry('claude.mts', 'pre-tool', bash('git commit --no-verify'));
  assert.equal(denied.status, 0);
  const decision: unknown = JSON.parse(denied.stdout);
  assert.deepEqual(Reflect.get(Reflect.get(Object(decision), 'hookSpecificOutput'), 'permissionDecision'), 'deny');
  const asked = runEntry('claude.mts', 'pre-tool', {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(ROOT, 'eslint.config.mjs') },
  });
  assert.match(asked.stdout, /"permissionDecision":"ask"/);
  const allowed = runEntry('claude.mts', 'pre-tool', bash('npm test'));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
});

test('Codex: an ask becomes a refusal that tells the agent to ask its human', () => {
  const result = runEntry('codex.mts', 'pre-tool', {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Update File: AGENTS.md\n*** End Patch' },
  });
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.match(result.stdout, /Ask your human/);
});

test('an unreadable payload fails loudly with the feedback exit code', () => {
  const script = path.join(ROOT, 'scripts', 'agent', 'claude.mts');
  const result = spawnSync(process.execPath, [script, 'pre-tool'], {
    cwd: ROOT,
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /hook payload is not JSON/);
});
