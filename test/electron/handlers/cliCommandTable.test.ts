// Goal: every row of the CLI command table has a handler once the CLI is loaded, so a command can never be listed (and offered to an AI agent as a tool)
// and then answer "not available".
// Method: the registration modules are loaded as the executable loads them, then each row is run on a fixture project with no arguments or wrong ones;
// whatever the refusal, it must not be `planner-unavailable`, and a read command must succeed.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import '#dist/electron/handlers/cliComponentCommands.js';
import { runCommand } from '#dist/electron/project/cli/cliRun.js';
import { COMMANDS } from '#dist/shared/properties/cli/stackiCommands.js';
import { makeProject, removeProjects } from '../../helpers/cliProject.ts';

afterEach(removeProjects);

test('no row of the command table answers planner-unavailable', async () => {
  const root = makeProject();
  for (const spec of COMMANDS) {
    const result = await runCommand({ words: spec.words, args: {}, project: root, role: {}, apply: 'plan', yes: 'no', waitSeconds: 0 });
    assert.ok(result.ok || result.error.code !== 'planner-unavailable', `${spec.words.join(' ')} has a handler`);
  }
});
