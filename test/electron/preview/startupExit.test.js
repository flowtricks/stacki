// Goal: intermediate startup exits never announce an offline preview during automatic retries.
// Method: run a temporary CLI that fails before serving HTTP, then verify fallback readiness,
// genuine exits after readiness, and the final rejection when every attempt fails.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DevServers } = require('#dist/electron/handlers/devServers.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

async function fixture(context, failures) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-startup-exit-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'astro.mjs');
  await fs.writeFile(
    bin,
    [
      'import {existsSync, readFileSync, writeFileSync} from "node:fs";',
      'import {createServer} from "node:http";',
      'if (process.argv.includes("logs")) process.exit(0);',
      'const count = existsSync("attempts") ? Number(readFileSync("attempts", "utf8")) : 0;',
      'writeFileSync("attempts", String(count + 1));',
      `if (count < ${failures}) { console.error("Temporary startup failure"); process.exit(1); }`,
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
      'createServer((request, response) => response.end("ready")).listen(port, "127.0.0.1");',
    ].join('\n'),
  );
  const events = [];
  const servers = new DevServers({ send: (channel, payload) => events.push({ channel, payload }) });
  // Keep the real process/retry logic; this CLI fixture needs no dependency installation.
  servers.installedBin = async () => bin;
  context.after(() => servers.stop());
  return { directory, events, servers };
}

test('startup retries stay loading, while an exit after readiness is reported', async (context) => {
  const { directory, events, servers } = await fixture(context, 2);
  const result = await servers.start(directory, () => {});
  assert.equal(result.bare, true, 'The third attempt uses the fallback configuration');
  assert.equal(await fs.readFile(path.join(directory, 'attempts'), 'utf8'), '3');
  assert.ok(
    events.some((event) => event.channel === 'dev:log'),
    'Diagnostics remain available',
  );
  assert.equal(events.filter((event) => event.channel === 'dev:exit').length, 0);
  const child = servers.current().proc;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal(events.filter((event) => event.channel === 'dev:exit').length, 1);
  assert.equal(servers.current(), undefined);
});

test('exhausted startup attempts fail through the start reply', async (context) => {
  const { directory, events, servers } = await fixture(context, 3);
  await assert.rejects(
    servers.start(directory, () => {}),
    /Temporary startup failure/,
  );
  assert.equal(await fs.readFile(path.join(directory, 'attempts'), 'utf8'), '3');
  assert.equal(events.filter((event) => event.channel === 'dev:exit').length, 0);
  assert.equal(servers.current(), undefined);
});
