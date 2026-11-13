// A stand-in ACP adapter for the host's tests: speaks just enough of the
// protocol (initialize, session/new, set_config_option, prompt, cancel) and,
// for a prompt, announces an edit, asks permission, writes the file through the
// client, streams text and ends the turn. "crash" in a prompt exits mid-turn;
// "sign in" answers AUTH_REQUIRED.
//
// Scenarios, chosen by what a prompt says (so a test needs no side channel):
//   usage         a usage_update with a 1,000,000-token window
//   background    a Bash call with run_in_background that finishes AFTER the turn
//   stream        a command whose output arrives as terminal deltas and again as result text
//   capabilities  echoes the client capabilities it was given as the agent's message
//   notice        a notice update, twice
//   hold          keeps the turn open until a steering message or a cancel arrives
//   unauthorized  an internal error carrying an HTTP 401, as Claude reports an expired login
//   /compact      compaction_update in_progress then completed ("/compact fail": failed)
// Other methods: `_session/steering` (accepted while a turn is held, `promptRequired` when idle,
// an error when the text says "refuse"), `session/fork` (answers `fork-of-<source>` with the
// source's modes), `session/set_mode`.
//
// Environment switches: FAKE_PLAIN=1 advertises no steering and no fork; FAKE_COMPACTION=tool
// reports /compact as a tool call titled "Compact conversation" (toolName "compact") instead of
// compaction_update, and FAKE_COMPACTION=silent reports nothing at all; FAKE_LEGACY_MODES=1 offers modes as session modes only (no `mode` option);
// FAKE_BYPASS=1 starts every new session in the "bypassPermissions" mode; FAKE_TRACE_FILE=<path> logs every method called;
// FAKE_COMMANDS=1 announces a slash command after each new session;
// FAKE_NEW_FAILS_FILE=<path> fails every new session while that file exists.
import fs from 'node:fs';
import readline from 'node:readline';

let next = 1000;
const waiting = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const plain = process.env.FAKE_PLAIN === '1';
const legacyModes = process.env.FAKE_LEGACY_MODES === '1';
// Claude's own mode ids, so Stacki's asking mode (`default`) and its unrestricted one are the real ones.
const startMode = process.env.FAKE_BYPASS === '1' ? 'bypassPermissions' : 'auto';
const MODES = [
  { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
  { id: 'auto', name: 'Auto' },
  { id: 'bypassPermissions', name: 'Bypass permissions' },
];
// The model the session reports; a `model` change moves it, and FAKE_REFUSE_MODEL makes the adapter refuse that change.
let modelValue = 'small';
let lastMode = startMode;
const options = (mode) => [
  ...(legacyModes
    ? []
    : [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: mode,
          options: MODES.map((entry) => ({ value: entry.id, name: entry.name })),
        },
      ]),
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelValue, options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
];
const modesOf = (mode) => (legacyModes ? { modes: { currentModeId: mode, availableModes: MODES } } : {});
let clientCapabilities;
let cancelled = false;
// The prompt a "hold" turn left open: answered when a steering message arrives or the turn is cancelled.
let held;

const finishHeld = (stopReason) => {
  if (held !== undefined) {
    send({ id: held.id, result: { stopReason } });
    held = undefined;
  }
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  // FAKE_TRACE_FILE: every method the client calls, one per line, so a test can count `session/new` calls.
  if (process.env.FAKE_TRACE_FILE !== undefined) {
    fs.appendFileSync(process.env.FAKE_TRACE_FILE, `${method}\n`);
  }
  if (method === 'initialize') {
    clientCapabilities = params.clientCapabilities;
    send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'fake', version: '1' },
        agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true }, ...(plain ? {} : { sessionCapabilities: { fork: {} } }) },
        ...(plain ? {} : { _meta: { steering: { supported: true } } }),
      },
    });
  } else if (method === 'session/new' && process.env.FAKE_NEW_FAILS_FILE !== undefined && fs.existsSync(process.env.FAKE_NEW_FAILS_FILE)) {
    // FAKE_NEW_FAILS_FILE=<path>: while that file exists, every new session fails (a start-early failure test removes it afterwards).
    send({ id, error: { code: -32603, message: 'Internal error' } });
  } else if (method === 'session/new') {
    modelValue = 'small';
    lastMode = startMode;
    const sessionId = `s${next++}`;
    send({ id, result: { sessionId, configOptions: options(startMode), ...modesOf(startMode) } });
    // FAKE_COMMANDS=1: slash commands arrive just after the session, as a real adapter announces them.
    if (process.env.FAKE_COMMANDS === '1') {
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the change' }] });
    }
  } else if (method === 'session/delete') {
    send({ id, result: {} });
  } else if (method === 'session/fork') {
    send({ id, result: { sessionId: `fork-of-${params.sessionId}`, configOptions: options('bypassPermissions'), ...modesOf('bypassPermissions') } });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      if (process.env.FAKE_REFUSE_MODEL === '1') {
        send({ id, error: { code: -32602, message: 'Model refused' } });
      } else {
        modelValue = params.value;
        send({ id, result: { configOptions: options(lastMode) } });
      }
    } else {
      lastMode = params.value;
      send({ id, result: { configOptions: options(params.value) } });
    }
  } else if (method === 'session/set_mode') {
    send({ id, result: {} });
    update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
  } else if (method === '_session/steering') {
    const text = params.prompt.map((block) => block.text ?? '').join('');
    if (text.includes('refuse')) {
      send({ id, error: { code: -32602, message: 'Steering refused' } });
    } else if (held === undefined) {
      send({ id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
    } else {
      send({ id, result: { outcome: 'steered' } });
      update(held.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Steered: ${text}` } });
      finishHeld('end_turn');
    }
  } else if (method === 'session/cancel') {
    cancelled = true;
    finishHeld('cancelled');
  } else if (method === 'session/prompt') {
    const text = params.prompt.find((block) => block.type === 'text')?.text ?? '';
    const sessionId = params.sessionId;
    if (text.includes('sign in')) {
      send({ id, error: { code: -32000, message: 'Authentication required' } });
      return;
    }
    if (text.includes('unauthorized')) {
      send({ id, error: { code: -32603, message: 'Internal error: API Error: 401 {"type":"error","error":{"type":"authentication_error"}} · Please run /login' } });
      return;
    }
    if (text.includes('crash')) {
      process.exit(3);
    }
    cancelled = false;
    if (text.startsWith('/compact')) {
      runCompaction(id, sessionId, text);
      return;
    }
    if (text.includes('hold')) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } });
      held = { id, sessionId };
      return;
    }
    const file = text.match(/edit (\S+)/)?.[1];
    if (file !== undefined) {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'edit1', title: `Edit ${file}`, kind: 'edit', status: 'pending', locations: [{ path: file }] });
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'edit1', title: `Edit ${file}`, kind: 'edit' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = answer.result?.outcome;
      if (outcome?.outcome !== 'selected' || outcome.optionId !== 'yes') {
        send({ id, result: { stopReason: 'cancelled' } });
        return;
      }
      const before = fs.readFileSync(file, 'utf8');
      await request('fs/write_text_file', { sessionId, path: file, content: before.replace('two', '2') });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit1', status: 'completed', content: [{ type: 'diff', path: file, oldText: before, newText: before.replace('two', '2') }] });
    }
    if (text.includes('capabilities')) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(clientCapabilities) } });
    }
    if (text.includes('stream')) {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'run1', title: 'Run it', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo ab' } });
      for (const data of ['a', 'b']) {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run1', _meta: { terminal_output_delta: { terminal_id: 't1', data } } });
      }
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'run1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ab' } }] });
    }
    // `aititle=One_two,Three`: session_info_update titles (underscores are spaces), as the Claude adapter sends its generated title.
    const titles = text.match(/aititle=(\S+)/)?.[1];
    if (titles !== undefined) {
      for (const title of titles.split(',')) {
        update(sessionId, { sessionUpdate: 'session_info_update', title: title.replaceAll('_', ' ') });
      }
    }
    if (text.includes('notice')) {
      for (let count = 0; count < 2; count++) {
        update(sessionId, { sessionUpdate: 'notice', severity: 'warning', title: 'Heads up', message: 'Something changed' });
      }
    }
    if (text.includes('background')) {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'bg1',
        title: 'Run the server',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'npm run dev', description: 'Dev server', run_in_background: true },
        _meta: { claudeCode: { toolName: 'Bash' } },
      });
      // The command finishes after the turn has ended.
      setTimeout(() => update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'bg1', status: 'completed' }), 300);
    }
    for (const word of ['Done', ' and', ' dusted.']) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } });
    }
    update(sessionId, { sessionUpdate: 'usage_update', used: text.includes('usage') ? 41250 : 10, size: text.includes('usage') ? 1_000_000 : 100 });
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
  } else {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
});

// `/compact`: the progress the adapter reports, in the shape the client's capabilities ask for.
function runCompaction(id, sessionId, text) {
  const failing = text.includes('fail');
  if (process.env.FAKE_COMPACTION === 'silent') {
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (process.env.FAKE_COMPACTION === 'tool') {
    const call = { sessionUpdate: 'tool_call', toolCallId: 'compact1', title: 'Compact conversation', kind: 'other', _meta: { claudeCode: { toolName: 'compact' } } };
    update(sessionId, { ...call, status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'compact1', status: failing ? 'failed' : 'completed', _meta: { claudeCode: { toolName: 'compact' } } });
    // A duplicate, as adapters repeat updates.
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'compact1', status: failing ? 'failed' : 'completed', _meta: { claudeCode: { toolName: 'compact' } } });
  } else {
    update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
    update(sessionId, failing ? { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: 'Nothing to compact' } : { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
    update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
  }
  update(sessionId, { sessionUpdate: 'usage_update', used: 5000, size: 1_000_000 });
  // The turn ends `end_turn` even when compaction failed, as the real adapter's does.
  send({ id, result: { stopReason: 'end_turn' } });
}
