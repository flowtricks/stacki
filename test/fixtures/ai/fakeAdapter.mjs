// A stand-in ACP adapter for the host's tests: speaks just enough of the
// protocol (initialize, session/new, set_config_option, prompt, cancel) and,
// for a prompt, announces an edit, asks permission, writes the file through the
// client, streams text and ends the turn. "crash" in a prompt exits mid-turn;
// "sign in" answers AUTH_REQUIRED.
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
const options = (mode) => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
];
let cancelled = false;

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '1' }, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } } });
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: `s${next++}`, configOptions: options('auto') } });
  } else if (method === 'session/set_config_option') {
    send({ id, result: { configOptions: options(params.value) } });
  } else if (method === 'session/cancel') {
    cancelled = true;
  } else if (method === 'session/prompt') {
    const text = params.prompt.find((block) => block.type === 'text')?.text ?? '';
    const sessionId = params.sessionId;
    if (text.includes('sign in')) {
      send({ id, error: { code: -32000, message: 'Authentication required' } });
      return;
    }
    if (text.includes('crash')) {
      process.exit(3);
    }
    cancelled = false;
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
    for (const word of ['Done', ' and', ' dusted.']) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word } });
    }
    update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 });
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
  } else {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  }
});
