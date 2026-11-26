// Goal: a subagent's work reads as steps a designer understands, and the Running panel's model says truthfully what
// runs and what finished. Each call is sorted into a kind of step by a table (the tool's name, its kind, and for a
// command the programs people recognise), always with "Ran a task in the project" as the safe fallback; consecutive calls of
// one kind merge into one step with a count, its files, a status (running while any call runs, else the newest
// outcome) and a time from its first start to its last end. The negative space: an unknown tool or program, an
// empty list, a stored call with no stamps or names, a huge run, a command line of megabytes, quotes that never
// close, and commands that carry secrets (an env value, a token, a key) must all degrade to plain words and never
// put the secret, a long hex run or a raw command into a label. Titles lose their ids and are sentence cased.
// Method: the pure modules (toolWords.ts `classifyStep`, agentSteps.ts, runningWork.ts, subagents.ts `cleanTitle`)
// are called directly with the English catalog; the view model is fed by the real pipeline (acpWire parsing, the
// host's event builder, the wire check, the reducer) from the recorded streams test/fixtures/ai/runningWork.jsonl
// (a long-running agent with 31 calls of every kind, a failed agent, a stopped agent, background commands) and
// test/fixtures/ai/subagentStream.jsonl, both in claude-agent-acp 0.105.0's shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath } = require('../../helpers/sources.js');

const words = loadRenderer('src/features/ai/transcript/toolWords.ts');
const steps = loadRenderer('src/features/ai/transcript/agentSteps.ts');
const running = loadRenderer('src/features/ai/runningWork.ts');
const subagents = loadRenderer('src/features/ai/subagents.ts');
const wire = loadRenderer('shared/properties/ai/acpWire.ts');
const { eventsForUpdate } = loadRenderer('electron/handlers/ai/chatEvents.ts');
const { parseChatEvent } = loadRenderer('shared/properties/ai/chatModel.ts');
const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');
const { ENGLISH_TRANSLATE: translate } = loadRenderer('shared/properties/i18n/englishTranslator.ts');

const TURN = `t${'1'.padStart(16, '0')}`;
const HEX_RUN = /[0-9a-f]{12,}/iu;

let nextId = 0;
/** A reducer `ToolItem` with every field; `over` sets what a case is about. */
const item = (over = {}) => {
  nextId += 1;
  return {
    kind: 'tool',
    id: nextId,
    turn: TURN,
    call: `k${nextId}`,
    title: 'Tool',
    toolKind: 'other',
    status: 'completed',
    paths: [],
    diffs: [],
    output: '',
    exitCode: undefined,
    parent: 'toolu_a',
    at: undefined,
    endedAt: undefined,
    toolName: undefined,
    command: undefined,
    background: false,
    agentType: undefined,
    agentModel: undefined,
    resultFrom: undefined,
    sentMessage: undefined,
    sentTo: undefined,
    ...over,
  };
};
const bash = (command, over = {}) => item({ title: command, command, toolKind: 'execute', toolName: 'Bash', ...over });
const label = (calls, working = false) => steps.groupSteps(calls, { working }).groups.map((group) => steps.stepLabel(group, translate));

// ---------------------------------------------------------------------------
// The classifier table
// ---------------------------------------------------------------------------

test('each kind of command is sorted into its step, with the subject a designer can read', () => {
  const table = [
    ['npm test', 'test', undefined],
    ['env -u ELECTRON_RUN_AS_NODE npm test -- subagents', 'test', undefined],
    ['npx vitest run src', 'test', undefined],
    ['pnpm exec playwright test', 'test', undefined],
    ['node --test test/a.test.js', 'test', undefined],
    ['python3 -m pytest -q', 'test', undefined],
    ['npm run check:changed', 'check', undefined],
    ['npx prettier --write .', 'check', undefined],
    ['npx tsc --noEmit', 'check', undefined],
    ['npm run lint', 'check', undefined],
    ['npm run build', 'build', undefined],
    ['astro build', 'build', undefined],
    ['npm install', 'install', undefined],
    ['pnpm add -D vitest', 'install', undefined],
    ['yarn', 'install', undefined],
    ['pip install requests', 'install', undefined],
    ['brew install ffmpeg', 'install', undefined],
    ['npm run dev', 'devServer', undefined],
    ['npx astro dev --port 4321', 'devServer', undefined],
    ['vite', 'devServer', undefined],
    ['git add -A && git commit -m "Release 1.4.14"', 'commit', undefined],
    ['git push origin main', 'push', undefined],
    ['git -C site status', 'history', undefined],
    ['git diff HEAD~1', 'history', undefined],
    ['git checkout -b feature', 'git', undefined],
    ['gh pr create --fill', 'git', undefined],
    ['curl -s https://example.com/a.json', 'web', undefined],
    ['wget https://example.com/file.zip', 'web', undefined],
    ['mkdir -p dist && cp a.svg dist/', 'files', undefined],
    ['rm -rf .cache', 'files', undefined],
    ['node scripts/build-icons.mjs --out dist', 'script', 'build-icons.mjs'],
    ['node --experimental-strip-types scripts/release.ts', 'script', 'release.ts'],
    ['python3 tools/resize.py a.png', 'script', 'resize.py'],
    ['./scripts/setup.sh', 'script', 'setup.sh'],
    ['npm run release:ship', 'script', 'release:ship'],
    ['grep -rn "arrow" src', 'search', 'arrow'],
    ['rg -e TODO src', 'search', 'TODO'],
    ['find . -name "*.astro"', 'search', '*.astro'],
    ['cat src/components/Hero.astro', 'read', 'Hero.astro'],
    ["sed -i '' 's/a/b/' x.css", 'edit', undefined],
    ['cd site && npm test', 'test', undefined],
    ['echo done', 'command', undefined],
    ['docker compose up', 'command', undefined],
    ['node -e "console.log(1)"', 'command', undefined],
    ['', 'command', undefined],
  ];
  for (const [command, kind, subject] of table) {
    const facts = words.classifyStep(bash(command));
    assert.equal(facts.kind, kind, `${JSON.stringify(command)} is ${kind}`);
    assert.equal(facts.subject, subject, `${JSON.stringify(command)} is about ${subject}`);
  }
});

test('tools are sorted by name, then by kind; an unknown tool is a tool step named by its name', () => {
  const table = [
    [{ toolName: 'Read', toolKind: 'read', paths: ['/site/src/Hero.astro'] }, 'read', 'src/Hero.astro'],
    [{ toolName: 'Edit', toolKind: 'edit', diffs: [{ path: '/site/src/Nav.astro', oldText: 'a', newText: 'b' }] }, 'edit', 'src/Nav.astro'],
    [{ toolName: 'Write', toolKind: 'edit', paths: ['/site/new.css'] }, 'edit', 'new.css'],
    [{ toolName: 'Grep', toolKind: 'search', title: 'grep -i -n --include="*.tsx" "arrow" src' }, 'search', 'arrow'],
    [{ toolName: 'Glob', toolKind: 'search', title: 'Find `**/*.astro`' }, 'search', undefined],
    [{ toolName: 'WebSearch', toolKind: 'fetch' }, 'web', undefined],
    [{ toolName: 'WebFetch', toolKind: 'fetch' }, 'web', undefined],
    [{ toolName: 'AskUserQuestion' }, 'ask', undefined],
    [{ toolName: 'TodoWrite' }, 'todo', undefined],
    [{ toolName: 'ExitPlanMode', toolKind: 'switch_mode' }, 'plan', undefined],
    [{ toolName: 'Agent', toolKind: 'think' }, 'helper', undefined],
    [{ toolName: 'SendMessage' }, 'message', undefined],
    [{ toolName: 'BashOutput' }, 'command', undefined],
    [{ toolName: undefined, toolKind: 'read', paths: [] }, 'read', undefined],
    [{ toolName: undefined, toolKind: 'delete' }, 'files', undefined],
    [{ toolName: undefined, toolKind: 'fetch' }, 'web', undefined],
    [{ toolName: undefined, toolKind: 'execute', title: 'npm test', command: undefined }, 'test', undefined],
  ];
  for (const [over, kind, subject] of table) {
    const facts = words.classifyStep(item(over));
    assert.equal(facts.kind, kind, `${JSON.stringify(over)} is ${kind}`);
    assert.equal(facts.subject, subject, `${JSON.stringify(over)} is about ${subject}`);
  }
  const unknown = words.classifyStep(item({ toolName: 'mcp__figma__get_page_layout', title: 'mcp__figma__get_page_layout' }));
  assert.deepEqual(unknown, { kind: 'tool', subject: undefined, name: 'mcp__figma__get_page_layout' });
  assert.deepEqual(label([item({ toolName: 'mcp__figma__get_page_layout', title: 'mcp__figma__get_page_layout' })]), ['Used Get Page Layout']);
  // A stored call of an older version: no name, no kind of its own, its stored title.
  assert.deepEqual(label([item({ title: 'Tool', toolName: undefined })]), ['Took a step'], 'the reducer’s stand-in title names nothing');
  assert.deepEqual(label([item({ title: '', toolName: undefined })]), ['Took a step'], 'nothing to go on: the generic words');
  assert.ok(
    words.STEP_KINDS.every((kind) => typeof kind === 'string'),
    'the kinds are a closed list',
  );
});

test('secrets never reach a label: env values, tokens, keys and long random runs are dropped, the step still named', () => {
  const secrets = [
    'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 git push origin main',
    'OPENAI_API_KEY=sk-live-0123456789abcdef npm test',
    'curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com',
    'node scripts/ghp_abcdefghijklmnop1234.mjs',
    'grep -rn "sk-proj-0123456789abcdefghij" .',
    'npm run deploy:AKIA0123456789ABCDEF',
    `grep "${'a1b2c3d4'.repeat(8)}" src`,
    'PASSWORD=hunter2 ./run.sh',
  ];
  for (const command of secrets) {
    const facts = words.classifyStep(bash(command));
    const shown = label([bash(command)]).join(' ');
    for (const secret of ['ghp_', 'sk-', 'Bearer', 'AKIA', 'hunter2', 'a1b2c3d4a1b2']) {
      assert.ok(!shown.includes(secret), `${command} shows no ${secret}: ${shown}`);
    }
    assert.ok(!HEX_RUN.test(shown), `no long hex in ${shown}`);
    assert.notEqual(facts.kind, undefined);
  }
  assert.equal(words.classifyStep(bash(secrets[0])).kind, 'push', 'the env assignment is taken off; the push is still a push');
  assert.equal(words.classifyStep(bash(secrets[1])).kind, 'test');
  assert.equal(words.looksSecret('Hero.astro'), false);
  assert.equal(words.looksSecret('build-icons.mjs'), false);
  assert.equal(words.looksSecret('MY_TOKEN'), true);
});

test('malicious and huge commands are read within their bounds and never throw', () => {
  const huge = `npm test ${'x'.repeat(5_000_000)}`;
  assert.equal(words.classifyStep(bash(huge)).kind, 'test', 'a megabyte command line is read from its start');
  const chain = Array.from({ length: 10_000 }, () => 'echo a').join(' && ') + ' && git commit -m x';
  assert.equal(words.classifyStep(bash(chain)).kind, 'command', 'pieces past the bound are not read');
  assert.ok(words.commandPieces(chain).length <= words.STEP_WORDS_LIMITS.piecesRead);
  const unclosed = 'grep "never closes src && rm -rf /';
  assert.equal(words.classifyStep(bash(unclosed)).kind, 'search', 'an unclosed quote swallows the rest, it does not break');
  const control = 'node \u0007\u0000evil‮.mjs';
  assert.equal(words.classifyStep(bash(control)).subject, undefined, 'control and format characters are no name');
  const wrapped = `${'npx '.repeat(50)}vitest`;
  assert.equal(words.classifyStep(bash(wrapped)).kind, 'command', 'wrappers past their depth stop being read');
  const longName = `node scripts/${'a'.repeat(200)}.mjs`;
  const subject = words.classifyStep(bash(longName)).subject;
  assert.ok(subject === undefined || subject.length <= words.STEP_WORDS_LIMITS.subjectCharsMax, 'a subject is bounded');
  const words1000 = `grep ${Array.from({ length: 1000 }, (_, index) => `-${index}`).join(' ')} needle`;
  assert.doesNotThrow(() => words.classifyStep(bash(words1000)));
});

// ---------------------------------------------------------------------------
// Merging into steps
// ---------------------------------------------------------------------------

test('consecutive calls of one kind merge into one step with a count, its files, its status and its time', () => {
  const read = (path, at) => item({ toolName: 'Read', toolKind: 'read', paths: [path], at, endedAt: at + 100 });
  const calls = [
    read('/s/A.astro', 1000),
    read('/s/B.astro', 1200),
    read('/s/A.astro', 1400),
    item({ toolName: 'Edit', toolKind: 'edit', paths: ['/s/Button.astro'], at: 2000, endedAt: 2500 }),
    item({ toolName: 'Edit', toolKind: 'edit', paths: ['/s/Hero.astro'], at: 2600, endedAt: 3000 }),
    item({ toolName: 'Edit', toolKind: 'edit', paths: ['/s/Nav.astro'], at: 3100, endedAt: 3200 }),
    bash('npm test', { status: 'failed', at: 4000, endedAt: 5000 }),
    bash('npm test', { at: 6000, endedAt: 7000 }),
    bash('npm run dev', { status: 'in_progress', at: 8000 }),
  ];
  const timeline = steps.groupSteps(calls, { working: true });
  assert.deepEqual(
    timeline.groups.map((group) => steps.stepLabel(group, translate)),
    ['Read 2 files', 'Edited 3 files (Button.astro, Hero.astro, …)', 'Ran the tests (2 times)', 'Started the dev server'],
  );
  const [reads, edits, tests, dev] = timeline.groups;
  assert.equal(reads.count, 3, 'three calls');
  assert.equal(reads.fileCount, 2, 'two distinct files');
  assert.equal(steps.stepDurationMs(reads), 500, 'from the first start to the last end');
  assert.equal(edits.status, 'done');
  assert.equal(tests.status, 'done', 'the newest outcome counts: a failed run, then a passing one');
  assert.equal(tests.failed, 1);
  assert.equal(dev.status, 'running');
  assert.equal(steps.stepDurationMs(dev), undefined, 'a running step has no duration yet');
  assert.equal(timeline.tasks, 9);
  assert.equal(timeline.running, 1);
  assert.equal(steps.timelineSummary(timeline, translate), '9 tasks, 1 running');
  assert.equal(steps.timelineSummary({ tasks: 1, running: 0 }, translate), '1 task');
  assert.strictEqual(steps.groupSteps(calls, { working: true }), timeline, 'the same calls give the same timeline object');
  // The same calls of a subagent that stopped: nothing runs forever.
  const stopped = steps.groupSteps(calls, { working: false });
  assert.equal(stopped.groups[3].status, 'stopped');
  assert.equal(stopped.running, 0);
  // Two different tools do not merge; the same tool does.
  const tools = [item({ toolName: 'mcp__a__one' }), item({ toolName: 'mcp__a__one' }), item({ toolName: 'mcp__a__two' })];
  assert.deepEqual(label(tools), ['Used One (2 times)', 'Used Two']);
  // A finished command with a non-zero exit failed, whatever the agent reported.
  assert.equal(steps.callStatus({ status: 'completed', exitCode: 2, toolKind: 'execute' }, { working: true }), 'failed');
  assert.equal(steps.callStatus({ status: 'completed', exitCode: 0, toolKind: 'execute' }, { working: true }), 'done');
});

test('an empty list, a single call and a call of every kind each read as words', () => {
  assert.deepEqual(steps.groupSteps([], { working: true }), steps.EMPTY_TIMELINE);
  for (const kind of words.STEP_KINDS) {
    const text = steps.stepLabel({ kind, count: 1, files: [], fileCount: 0, subject: undefined, name: undefined }, translate);
    const many = steps.stepLabel({ kind, count: 3, files: [], fileCount: 0, subject: undefined, name: undefined }, translate);
    assert.ok(text.length > 0 && !text.includes('{'), `${kind}: ${text}`);
    assert.ok(many.length > 0 && !many.includes('{'), `${kind}: ${many}`);
    assert.notEqual(text, many, `${kind}: a run of three says so`);
  }
  assert.equal(
    steps.stepLabel({ kind: 'search', count: 1, files: [], fileCount: 0, subject: 'arrow', name: undefined }, translate),
    'Looked for “arrow” in the project',
  );
  assert.equal(steps.stepLabel({ kind: 'script', count: 1, files: [], fileCount: 0, subject: 'build.mjs', name: undefined }, translate), 'Ran build.mjs');
  assert.equal(steps.stepLabel({ kind: 'read', count: 2, files: ['A.astro'], fileCount: 1, subject: 'A.astro', name: undefined }, translate), 'Read A.astro');
});

test('a huge run keeps its newest steps and calls within their bounds and counts the rest', () => {
  const calls = [];
  for (let index = 0; index < 5_000; index += 1) {
    // Alternating kinds: every call starts a new step.
    calls.push(index % 2 === 0 ? bash('npm test') : item({ toolName: 'Read', toolKind: 'read', paths: [`/s/${index}.md`] }));
  }
  const timeline = steps.groupSteps(calls, { working: false });
  assert.equal(timeline.groups.length, steps.STEP_LIMITS.groupsMax);
  assert.equal(timeline.omittedGroups, 5_000 - steps.STEP_LIMITS.groupsMax);
  assert.equal(timeline.tasks, 5_000);
  const same = Array.from({ length: 3_000 }, (_, index) => item({ toolName: 'Read', toolKind: 'read', paths: [`/s/${index}.md`] }));
  const [one] = steps.groupSteps(same, { working: false }).groups;
  assert.equal(one.count, 3_000);
  assert.equal(one.calls.length, steps.STEP_LIMITS.callsPerGroupMax);
  assert.equal(one.omittedCalls, 3_000 - steps.STEP_LIMITS.callsPerGroupMax);
  assert.equal(one.fileCount, steps.STEP_LIMITS.filesCountedMax, 'the distinct files stop counting at their bound');
  assert.ok(one.files.length <= steps.STEP_LIMITS.filesNamedMax + 1);
  // The fold: the newest steps show, every step from the first running one shows, the rest fold.
  const split = steps.splitEarlier(timeline.groups);
  assert.equal(split.latest.length, steps.STEP_LIMITS.latestGroupsShown);
  assert.equal(split.earlier.length + split.latest.length, timeline.groups.length);
});

test('titles lose their ids, keep their own capitals, and are bounded', () => {
  assert.equal(subagents.cleanTitle('Release Stacki 1.4.14 (toolu_01ABCDEF2345) a7a4cd56faec575c0'), 'Release Stacki 1.4.14');
  assert.equal(subagents.cleanTitle('audit the hero'), 'Audit the hero');
  assert.equal(subagents.cleanTitle('FIX THE BUILD'), 'Fix the build');
  assert.equal(subagents.cleanTitle('Resume agent 4f9c2e1a-1b2c-4d5e-8f90-123456789abc'), 'Resume agent');
  assert.equal(subagents.cleanTitle('Check the CSS'), 'Check the CSS', 'an acronym among small letters stays');
  assert.equal(subagents.cleanTitle('a7a4cd56faec575c0'), '', 'only an id: nothing left');
  assert.equal(subagents.cleanTitle('Add 2024 deadline'), 'Add 2024 deadline', 'a number is not an id');
  assert.equal(subagents.cleanTitle('count_lines'), 'count_lines', 'a name written as an identifier stays as written');
  assert.ok(subagents.cleanTitle('x'.repeat(10_000)).length <= subagents.TITLE_CHARS_MAX);
});

// ---------------------------------------------------------------------------
// From the recorded stream to the panel's model
// ---------------------------------------------------------------------------

function chatOf(file, scenario, end) {
  const lines = fs
    .readFileSync(repoPath(file), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.scenario === scenario);
  assert.ok(lines.length > 0, `${file} has the ${scenario} scenario`);
  const events = [
    { kind: 'turn-start', turn: TURN, at: 0 },
    { kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 },
  ];
  for (const entry of lines) {
    const message = wire.parseAcpLine(entry.line);
    assert.ok(message.ok && message.value.kind === 'notification', entry.line);
    const notification = wire.parseSessionNotification(message.value.params);
    assert.ok(notification.ok, entry.line);
    events.push(...eventsForUpdate(notification.value.update, TURN, { at: entry.at }).map((event) => parseChatEvent(JSON.parse(JSON.stringify(event)))));
  }
  if (end !== undefined) {
    events.push({ kind: 'turn-end', turn: TURN, stop: end, message: undefined, at: 20_000 });
  }
  return reduceChat(EMPTY_CHAT, events);
}

const RUNNING_FIXTURE = 'test/fixtures/ai/runningWork.jsonl';

test('a long-running agent: 31 tasks, 1 running, in human steps, its title clean, its secrets kept out', () => {
  const view = chatOf(RUNNING_FIXTURE, 'long');
  const work = subagents.deriveSubagentWork(view);
  const model = running.deriveRunningWork(view, work);
  assert.equal(model.running.length, 1);
  const [row] = model.running;
  assert.equal(row.kind, 'agent');
  assert.equal(subagents.subagentName(row.unit.agent), 'Release Stacki 1.4.14', 'no tool call id, no agent id');
  const timeline = steps.groupSteps(row.unit.children, { working: true });
  assert.equal(steps.timelineSummary(timeline, translate), '31 tasks, 1 running');
  const labels = timeline.groups.map((group) => steps.stepLabel(group, translate));
  assert.deepEqual(labels, [
    'Read 5 files',
    'Looked for “arrow” in the project',
    'Edited 3 files (Button component, Hero component, …)',
    'Checked the code for mistakes',
    'Ran the tests (2 times)',
    'Committed changes',
    'Pushed changes',
    'Looked something up on the web',
    'Installed packages',
    'Organized files',
    'Ran build-icons.mjs',
    'Looked something up on the web',
    'Asked you a question',
    'Used Get Page Layout (2 times)',
    'Read 8 files',
    'Started the dev server',
  ]);
  const everything = labels.join('\n');
  assert.ok(!everything.includes('ghp_') && !everything.includes('GH_TOKEN') && !everything.includes('ELECTRON_RUN_AS_NODE'), everything);
  assert.ok(!HEX_RUN.test(everything));
  assert.deepEqual(running.chipState(model), { kind: 'working', agents: 1, commands: 0 });
  assert.equal(running.chipLabel(running.chipState(model), translate), '1 agent working');
});

test('a failed agent and a stopped agent are finished, with the failure and the stop on their steps', () => {
  const failed = chatOf(RUNNING_FIXTURE, 'failed', 'end_turn');
  const failedModel = running.deriveRunningWork(failed, subagents.deriveSubagentWork(failed));
  assert.equal(failedModel.running.length, 0);
  assert.equal(failedModel.finished.length, 1);
  assert.equal(failedModel.finished[0].status.kind, 'failed');
  const failedSteps = steps.groupSteps(failedModel.finished[0].unit.children, { working: false });
  assert.deepEqual(
    failedSteps.groups.map((group) => [steps.stepLabel(group, translate), group.status]),
    [
      ['Read astro.config.mjs', 'done'],
      ['Ran migrate.mjs', 'failed'],
    ],
  );
  assert.deepEqual(running.chipState(failedModel), { kind: 'finished', agents: 1, commands: 0, failed: 1 });
  assert.equal(running.chipLabel(running.chipState(failedModel), translate), '1 agent finished');

  const stopped = chatOf(RUNNING_FIXTURE, 'stopped', 'cancelled');
  const stoppedModel = running.deriveRunningWork(stopped, subagents.deriveSubagentWork(stopped));
  assert.equal(stoppedModel.finished[0].status.kind, 'stopped');
  const stoppedSteps = steps.groupSteps(stoppedModel.finished[0].unit.children, { working: false });
  assert.deepEqual(
    stoppedSteps.groups.map((group) => group.status),
    ['done', 'stopped'],
    'the command it left open is stopped, not running',
  );
  assert.equal(stoppedSteps.running, 0);
});

test('background commands: the dev server runs under its friendly name, the finished tests are listed, nothing raw is named', () => {
  const view = chatOf(RUNNING_FIXTURE, 'background', 'end_turn');
  const model = running.deriveRunningWork(view, subagents.deriveSubagentWork(view));
  assert.deepEqual(
    model.running.map((row) => [row.kind, running.commandName(row.command.step, translate)]),
    [['command', 'Dev server']],
  );
  assert.deepEqual(
    model.finished.map((row) => [row.kind, running.commandName(row.command.step, translate), row.status.kind]),
    [['command', 'Tests', 'done']],
  );
  assert.equal(running.chipLabel(running.chipState(model), translate), '1 background command');
  assert.ok(model.running[0].command.text.includes('npm run dev'), 'the exact command is kept for "Show technical details"');
  // Both kinds at once.
  assert.equal(running.chipLabel({ kind: 'working', agents: 2, commands: 1 }, translate), '2 agents working, 1 background command');
  assert.equal(running.chipLabel({ kind: 'finished', agents: 0, commands: 2, failed: 0 }, translate), '2 tasks finished');
  for (const kind of words.STEP_KINDS) {
    const name = running.commandName({ kind, subject: undefined, name: undefined }, translate);
    assert.ok(name !== '' && !name.includes('{'), `${kind}: ${name}`);
  }
  assert.equal(running.commandName({ kind: 'command', subject: undefined, name: 'python3' }, translate), 'python3 command');
});

test('the recorded subagent stream folds the same way; a chat with nothing running hides the chip', () => {
  const view = chatOf('test/fixtures/ai/subagentStream.jsonl', 'parallel');
  const model = running.deriveRunningWork(view, subagents.deriveSubagentWork(view));
  assert.deepEqual(
    model.running.map((row) => row.key),
    ['toolu_b'],
  );
  assert.deepEqual(
    model.finished.map((row) => row.key),
    ['toolu_a'],
  );
  const build = steps.groupSteps(model.running[0].unit.children, { working: true });
  assert.deepEqual(
    build.groups.map((group) => steps.stepLabel(group, translate)),
    ['Read shot-1.png', 'Built the project'],
  );
  assert.equal(running.chipLabel(running.chipState(model), translate), '1 agent working');
  assert.deepEqual(running.chipState(running.EMPTY_RUNNING), { kind: 'hidden' });
  const quiet = reduceChat(EMPTY_CHAT, [{ kind: 'user', turn: TURN, text: 'hi', attachments: [], at: 0 }]);
  assert.deepEqual(running.chipState(running.deriveRunningWork(quiet, subagents.deriveSubagentWork(quiet))), { kind: 'hidden' });
});

test('the finished list is bounded and newest first', () => {
  const events = [{ kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 }];
  for (let index = 0; index < 120; index += 1) {
    events.push({
      kind: 'tool',
      turn: TURN,
      call: `toolu_${index}`,
      title: `Task ${index}`,
      toolKind: 'think',
      toolName: 'Agent',
      status: 'completed',
      at: 1000 + index,
    });
  }
  const view = reduceChat(EMPTY_CHAT, events);
  const model = running.deriveRunningWork(view, subagents.deriveSubagentWork(view));
  assert.equal(model.finished.length, running.RUNNING_LIMITS.finishedMax);
  assert.equal(model.finishedOmitted, 120 - running.RUNNING_LIMITS.finishedMax);
  assert.equal(model.finished[0].key, 'toolu_119', 'newest first');
});
