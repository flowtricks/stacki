// Goal: the pure state behind starting an agent early keeps its promises, with no process,
// timer or disk involved: the slot is single-flight and holds one session at most, a stale
// warm-up can never park, a session is adopted once and only by its own agent and project,
// the idle timeout shortens exactly when the machine is crowded or short on memory, the
// least recently used idle process is the one evicted, and the startup log line carries
// durations and one of three words, never a path or a prompt.
// Methodology: the real classes from dist/, plain objects standing in for processes and
// sessions, the log line checked against a strict pattern and against hostile inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WarmSlot, StartupTimings, formatStartup, idleTimeoutMs, oldestIdle, type ParkedSession } from '#dist/electron/handlers/ai/sessionPool.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { PrewarmGate } from '#dist/shared/properties/ai/prewarmGate.js';

const claude = { agent: 'claude', root: '/work/site' } as const;
const codex = { agent: 'codex', root: '/work/site' } as const;
const elsewhere = { agent: 'claude', root: '/work/other' } as const;

function parked(process: object, sessionId = 's1'): ParkedSession {
  return { process, session: { sessionId, currentModeId: undefined, modes: [], options: [] }, sessionNewMs: 900, commands: [] };
}

test('the slot is single-flight: a second begin, from the same or another target, gets nothing', () => {
  const slot = new WarmSlot();
  assert.equal(slot.phase(), 'empty');
  const ticket = slot.begin(claude);
  assert.ok(ticket !== undefined);
  assert.equal(slot.phase(), 'starting');
  assert.equal(slot.begin(claude), undefined, 'the same target is already starting');
  assert.equal(slot.begin(codex), undefined, 'one warm-up per project, whatever the agent');
  assert.equal(slot.begin(elsewhere), undefined, 'one warm-up app-wide');
  assert.ok(slot.park(ticket, parked({})));
  assert.equal(slot.phase(), 'parked');
  assert.equal(slot.begin(claude), undefined, 'a parked session is not warmed again');
});

test('a ticket made stale by a release can neither park nor free the slot', () => {
  const slot = new WarmSlot();
  const stale = slot.begin(claude);
  assert.ok(stale !== undefined);
  assert.deepEqual(slot.release(), { phase: 'starting', target: claude });
  const fresh = slot.begin(codex);
  assert.ok(fresh !== undefined);
  assert.equal(slot.current(stale), false);
  assert.equal(slot.park(stale, parked({})), false, 'a stale warm-up deletes its own session instead');
  slot.abandon(stale);
  assert.equal(slot.phase(), 'starting', 'a stale abandon leaves the new warm-up alone');
  slot.abandon(fresh);
  assert.equal(slot.phase(), 'empty');
});

test('a parked session is taken once, and only by its own agent and project', () => {
  const slot = new WarmSlot();
  const process = {};
  const ticket = slot.begin(claude);
  assert.ok(ticket !== undefined);
  assert.equal(slot.take(claude), undefined, 'nothing is parked while it is still starting');
  assert.ok(slot.park(ticket, parked(process)));
  assert.equal(slot.take(codex), undefined, 'another agent in the same project never adopts it');
  assert.equal(slot.take(elsewhere), undefined, 'another project never adopts it');
  assert.equal(slot.phase(), 'parked', 'a refused take leaves it parked');
  const taken = slot.take(claude);
  assert.equal(taken?.session.sessionId, 's1');
  assert.equal(slot.take(claude), undefined, 'adopted once');
  assert.equal(slot.phase(), 'empty');
});

test('a send waits on the warm-up in flight, and only for its own target', async () => {
  const slot = new WarmSlot();
  const ticket = slot.begin(claude);
  assert.ok(ticket !== undefined);
  assert.equal(slot.inflight(claude), undefined, 'nothing to wait on before the promise is attached');
  let finish: () => void = () => undefined;
  slot.attach(ticket, new Promise<void>((resolve) => (finish = resolve)));
  assert.ok(slot.inflight(claude) !== undefined);
  assert.equal(slot.inflight(codex), undefined);
  finish();
  await slot.inflight(claude);
});

test('a stopped process takes its parked session with it; another process does not', () => {
  const slot = new WarmSlot();
  const process = {};
  const ticket = slot.begin(claude);
  assert.ok(ticket !== undefined);
  assert.ok(slot.park(ticket, parked(process)));
  assert.equal(slot.releaseProcess({}), undefined, 'a different process leaves the slot alone');
  assert.equal(slot.phase(), 'parked');
  const released = slot.releaseProcess(process);
  assert.equal(released?.phase, 'parked');
  assert.equal(slot.phase(), 'empty');
});

test('commands announced after session/new reach the parked session, bounded', () => {
  const slot = new WarmSlot();
  const ticket = slot.begin(claude);
  assert.ok(ticket !== undefined);
  assert.equal(slot.noteCommands('s1', ['a']), false, 'not parked yet');
  assert.ok(slot.park(ticket, parked({})));
  assert.equal(slot.noteCommands('other', ['a']), false);
  assert.equal(
    slot.noteCommands(
      's1',
      Array.from({ length: AI_LIMITS.commandsMax + 10 }, (_unused, index) => `c${index}`),
    ),
    true,
  );
  assert.equal(slot.take(claude)?.commands.length, AI_LIMITS.commandsMax);
});

test('the idle timeout is 30 minutes, shortens when crowded or squeezed, and stays bounded', () => {
  assert.equal(AI_LIMITS.idleMsMax, 30 * 60 * 1000);
  assert.ok(AI_LIMITS.idleMsCrowded < AI_LIMITS.idleMsMax);
  assert.equal(idleTimeoutMs({ processes: 1, freeMemoryRatio: 0.5 }), AI_LIMITS.idleMsMax);
  assert.equal(idleTimeoutMs({ processes: AI_LIMITS.processesComfortableMax, freeMemoryRatio: 0.5 }), AI_LIMITS.idleMsMax, 'two is still comfortable');
  assert.equal(idleTimeoutMs({ processes: AI_LIMITS.processesComfortableMax + 1, freeMemoryRatio: 0.5 }), AI_LIMITS.idleMsCrowded);
  assert.equal(idleTimeoutMs({ processes: 1, freeMemoryRatio: AI_LIMITS.memoryFreeRatioMin / 2 }), AI_LIMITS.idleMsCrowded);
  assert.throws(() => idleTimeoutMs({ processes: -1, freeMemoryRatio: 0.5 }), /not negative/);
  assert.throws(() => idleTimeoutMs({ processes: 1.5, freeMemoryRatio: 0.5 }), /whole process count/);
});

test('the process evicted first is the idle one used longest ago', () => {
  assert.equal(oldestIdle([]), undefined);
  assert.equal(oldestIdle([{ lastUsedAt: 5, busy: true }]), undefined, 'a busy process is never evicted');
  assert.equal(
    oldestIdle([
      { lastUsedAt: 10, busy: false },
      { lastUsedAt: 2, busy: true },
      { lastUsedAt: 4, busy: false },
      { lastUsedAt: 4, busy: false },
    ]),
    2,
    'least recently used among the idle; a tie goes to the earlier one',
  );
});

test('the startup line is durations and one of three words, reported once at the first token', () => {
  const timings = new StartupTimings();
  const process = {};
  timings.noteProcess(process, { spawnMs: 40, initializeMs: 310 });
  timings.noteSend('chat-1', 1_000);
  timings.noteSession('chat-1', process, 'prewarmed', 880);
  const line = timings.noteFirstToken('chat-1', 1_450);
  assert.equal(line, 'startup: session=prewarmed spawnMs=40 initializeMs=310 sessionNewMs=880 firstTokenMs=450');
  assert.equal(timings.noteFirstToken('chat-1', 2_000), undefined, 'reported once');
  for (const origin of ['prewarmed', 'cold', 'resumed'] as const) {
    const text = formatStartup({ origin, process: { spawnMs: undefined, initializeMs: 1.6 }, sessionNewMs: undefined, firstTokenMs: -5 });
    assert.match(text, /^startup: session=(prewarmed|cold|resumed) spawnMs=none initializeMs=2 sessionNewMs=none firstTokenMs=0$/);
  }
});

test('a chat that never sent, or was forgotten, reports nothing; the maps stay bounded', () => {
  const timings = new StartupTimings();
  const process = {};
  timings.noteSession('quiet', process, 'cold', 10);
  assert.equal(timings.noteFirstToken('quiet', 5), undefined, 'a session with no send has no first token to measure');
  timings.noteSend('gone', 1);
  timings.noteSession('gone', process, 'cold', 10);
  timings.forget('gone');
  assert.equal(timings.noteFirstToken('gone', 9), undefined);
  for (let index = 0; index < 500; index++) {
    timings.noteSend(`c${index}`, index);
    timings.noteSession(`c${index}`, process, 'resumed', 1);
  }
  assert.equal(timings.noteFirstToken('c0', 600), undefined, 'the oldest pending startup was dropped, not the map grown');
  assert.ok(timings.noteFirstToken('c499', 600) !== undefined);
});

test('the startup line carries no prompt text and no path', () => {
  const timings = new StartupTimings();
  const process = {};
  timings.noteProcess(process, { spawnMs: 1, initializeMs: 2 });
  timings.noteSend('/Users/me/secret project', 0);
  timings.noteSession('/Users/me/secret project', process, 'cold', 3);
  const line = timings.noteFirstToken('/Users/me/secret project', 4);
  assert.ok(line !== undefined);
  assert.doesNotMatch(line, /Users|secret|\//);
});

test('the renderer gate sends one start-early request per agent per interval and releases only what it asked for', () => {
  const gate = new PrewarmGate();
  assert.equal(gate.decide('/site', 'claude', 'release', 0), false, 'nothing asked, nothing to release');
  assert.equal(gate.decide('/site', 'claude', 'warm', 0), true);
  assert.equal(gate.decide('/site', 'claude', 'warm', 10), false, 'rapid focus');
  assert.equal(gate.decide('/site', 'claude', 'warm', AI_LIMITS.prewarmRepeatMs - 1), false);
  assert.equal(gate.decide('/site', 'claude', 'warm', AI_LIMITS.prewarmRepeatMs), true);
  assert.equal(gate.decide('/site', 'codex', 'warm', AI_LIMITS.prewarmRepeatMs + 1), true, 'another agent is a new request');
  assert.equal(gate.decide('/site', 'claude', 'release', AI_LIMITS.prewarmRepeatMs + 2), false, 'the claude request was replaced by codex');
  assert.equal(gate.decide('/site', 'codex', 'release', AI_LIMITS.prewarmRepeatMs + 3), true);
  assert.equal(gate.decide('/site', 'codex', 'release', AI_LIMITS.prewarmRepeatMs + 4), false, 'released once');
  assert.equal(gate.decide('/site', 'codex', 'warm', AI_LIMITS.prewarmRepeatMs + 5), true, 'a release lets the next open warm at once');
  assert.throws(() => gate.decide('', 'codex', 'warm', 0), /a project/);
});
