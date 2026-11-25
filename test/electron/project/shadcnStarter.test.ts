// Exercise the actual stage, content writer, Git history and publication with a
// local fixture at the CLI boundary, so the regression suite needs no network.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createShadcnStarter, inspectShadcnPreset, SHADCN_CLI_PACKAGE } from '#dist/electron/project/shadcnStarter.js';
import { shadcnRegistryItems } from '#dist/electron/project/shadcnStarterCatalog.js';
import { parseDefaultsSource } from '#dist/shared/properties/componentDefaults.js';
import { RUN_CANCELLED, runCreateCommand } from '#dist/electron/project/starter.js';

type Request = Parameters<typeof createShadcnStarter>[0];
type Runner = typeof runCreateCommand;

async function parentFolder(context: TestContext): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'stacki shadcn starter '));
  context.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

function requestAt(parentPath: string): Request {
  return {
    starter: 'shadcn',
    parentPath,
    name: 'new-site',
    packageManager: 'pnpm',
    shadcn: { base: 'aria', iconLibrary: 'tabler', preset: 'b1QGlW', pointer: true, rtl: true },
  };
}

function cliFixture(request: Request, lockfile = 'pnpm-lock.yaml', duringAdd?: (directory: string) => Promise<void>) {
  const calls: (readonly string[])[] = [];
  const style = request.shadcn.style ?? 'nova';
  const run: Runner = async (command, argumentsList, directory, onLog, options) => {
    if (command === 'git') {
      return runCreateCommand(command, argumentsList, directory, onLog, options);
    }
    if (argumentsList[0] === '--version') {
      return '12.23.0';
    }
    if (argumentsList[0] === 'add') {
      calls.push(argumentsList);
      assert.match(command, /^pnpm(?:\.cmd)?$/);
      assert.deepEqual(argumentsList, ['add', '@tanstack/react-table@8.21.3', 'react-qr-code@2.2.0']);
      return '';
    }
    const start = argumentsList.indexOf(SHADCN_CLI_PACKAGE);
    assert.ok(start >= 0);
    const argumentsAfterLauncher = argumentsList.slice(start + 1);
    calls.push(argumentsAfterLauncher);
    assert.equal(options?.waitForStop, true);
    switch (argumentsAfterLauncher[0]) {
      case 'preset':
        assert.equal(options?.stdoutOnly, true);
        return JSON.stringify({ code: 'b1QGlW', values: { iconLibrary: 'hugeicons', style: 'nova' } });
      case 'init': {
        assert.match(path.basename(directory), /^\.stacki-shadcn-/);
        assert.match(command, /^pnpm(?:\.cmd)?$/);
        assert.equal(options?.environment?.['COREPACK_ENABLE_PROJECT_SPEC'], '0');
        assert.equal(await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8'), 'packages: []\n');
        const project = path.join(directory, 'generation', request.name);
        await mkdir(path.join(project, 'src/styles'), { recursive: true });
        await mkdir(path.join(project, '.git'));
        await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: request.name, dependencies: { astro: '^7' } }));
        await writeFile(path.join(project, lockfile), 'generated lockfile\n');
        await writeFile(path.join(project, 'src/styles/global.css'), ':root { --primary: blue; }\n');
        await writeFixtureConfig(project, 'hugeicons', style);
        return '';
      }
      case 'migrate':
        await writeFixtureConfig(directory, 'tabler', style);
        return '';
      case 'add': {
        const installed = path.join(directory, 'src/components/ui');
        await mkdir(installed, { recursive: true });
        for (const item of shadcnRegistryItems(request.shadcn.base)) {
          if (item !== 'form') {
            await writeFile(path.join(installed, `${item}.tsx`), 'export {};\n');
          }
        }
        await duringAdd?.(directory);
        return '';
      }
      case undefined:
      default:
        throw new Error(`Unexpected CLI command ${argumentsAfterLauncher.join(' ')}`);
    }
  };
  return { calls, run };
}

function writeFixtureConfig(directory: string, iconLibrary: string, style: string): Promise<void> {
  return writeFile(path.join(directory, 'components.json'), JSON.stringify({ style: `aria-${style}`, rtl: true, iconLibrary }));
}

test('inspects a preset through the official decoder and validates decoded data', async () => {
  const fixture = cliFixture(requestAt('/unused'));
  assert.deepEqual(await inspectShadcnPreset('b1QGlW', fixture.run), { ok: true, value: { iconLibrary: 'hugeicons', style: 'nova' } });
  assert.deepEqual(fixture.calls, [['preset', 'decode', 'b1QGlW', '--json']]);
  const invalid = await inspectShadcnPreset('bInvalid', async () => {
    throw new Error('Invalid preset code');
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.match(invalid.error.message, /Invalid preset code/);
  }
  const badReply = await inspectShadcnPreset('b0', async () => '{"code":"b0","values":{"iconLibrary":"other"}}');
  assert.equal(badReply.ok, false);
});

test('installs the chosen named style without a preset code', async (context) => {
  const parent = await parentFolder(context);
  const template = requestAt(parent);
  const request: Request = { ...template, shadcn: { base: 'aria', style: 'rhea', iconLibrary: 'tabler', rtl: true, pointer: true } };
  const fixture = cliFixture(request);
  const { projectPath } = await createShadcnStarter(request, () => undefined, fixture.run);
  const init = fixture.calls[0];
  assert.equal(init?.[0], 'init');
  assert.equal(init?.[init.indexOf('--preset') + 1], 'rhea');
  assert.match(await readFile(path.join(projectPath, 'src/components/examples/create-style-preview/style.ts'), 'utf8'), /usePreviewTypography/);
  assert.match(await readFile(path.join(projectPath, 'src/components/examples/create-preview/style.ts'), 'utf8'), /style: "rhea"/);
});

test('rejects a conflicting style before scaffolding a custom preset', async (context) => {
  const parent = await parentFolder(context);
  const template = requestAt(parent);
  const request: Request = { ...template, shadcn: { ...template.shadcn, style: 'mira' } };
  const fixture = cliFixture(request);
  await assert.rejects(
    createShadcnStarter(request, () => undefined, fixture.run),
    /style does not match the preset code/,
  );
  assert.deepEqual(fixture.calls, [['preset', 'decode', 'b1QGlW', '--json']]);
  assert.deepEqual(await readdir(parent), []);
});

test('migrates the preset icon, adds components, and publishes a complete site with one initial commit', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  await writeFile(path.join(parent, 'package-lock.json'), 'parent lockfile');
  const fixture = cliFixture(request);
  const logs: string[] = [];
  const { projectPath } = await createShadcnStarter(request, (text) => logs.push(text), fixture.run);
  assert.equal(projectPath, path.join(await realpath(parent), request.name));
  assert.deepEqual(fixture.calls[0], ['preset', 'decode', 'b1QGlW', '--json']);
  assert.deepEqual(fixture.calls[1], [
    'init',
    '--cwd',
    'generation',
    '--template',
    'astro',
    '--no-monorepo',
    '--name',
    request.name,
    '--base',
    'aria',
    '--preset',
    'b1QGlW',
    '--yes',
    '--pointer',
    '--rtl',
  ]);
  assert.deepEqual(fixture.calls[2], ['migrate', 'icons', '--from', 'hugeicons', '--to', 'tabler', '--yes']);
  assert.deepEqual(fixture.calls[3], ['add', ...shadcnRegistryItems('aria'), '--yes', '--overwrite']);
  assert.deepEqual(fixture.calls[4], ['add', '@tanstack/react-table@8.21.3', 'react-qr-code@2.2.0']);
  assert.match(logs.join(''), /shadcn@4\.23\.0 init/);
  assert.deepEqual((await readdir(parent)).sort(), ['new-site', 'package-lock.json']);
  assert.equal(await readFile(path.join(parent, 'package-lock.json'), 'utf8'), 'parent lockfile');
  assert.equal(await readFile(path.join(projectPath, 'src/styles/global.css'), 'utf8'), ':root { --primary: blue; }\n');
  const git = (argumentsList: readonly string[]): Promise<string> => runCreateCommand('git', argumentsList, projectPath);
  assert.equal((await git(['rev-list', '--count', 'HEAD'])).trim(), '1');
  assert.equal((await git(['status', '--porcelain'])).trim(), '');
  assert.equal((await git(['remote'])).trim(), '');
  const tracked = await git([
    'ls-files',
    '--',
    '.stacki',
    'src/pages',
    'src/components/shadcn/MessageScroller.astro',
    'src/components/shadcn/DataTable.astro',
    'pnpm-lock.yaml',
  ]);
  assert.match(tracked, /\.stacki\/components\.json/);
  assert.match(tracked, /\.stacki\/styles\.json/);
  assert.match(tracked, /src\/pages\/example-components\.astro/);
  assert.match(tracked, /src\/components\/shadcn\/MessageScroller\.astro/);
  assert.match(tracked, /src\/components\/shadcn\/DataTable\.astro/);
  const defaults = parseDefaultsSource(await readFile(path.join(projectPath, '.stacki/components.json'), 'utf8'));
  assert.ok(defaults.ok);
  assert.equal(Object.keys(defaults.value.components).length, 65);
  assert.ok(Object.hasOwn(defaults.value.components, 'src/components/Card.astro'));
  assert.ok(Object.hasOwn(defaults.value.components, 'src/components/shadcn/Form.astro'));
  assert.equal(Object.hasOwn(defaults.value.components, 'src/components/shadcn/Menubar.astro'), false);
  assert.equal(Object.hasOwn(defaults.value.components, 'src/components/shadcn/Toast.astro'), false);
  assert.match(tracked, /pnpm-lock\.yaml/);
  const example = await readFile(path.join(projectPath, 'src/components/examples/catalog/MessageScroller.tsx'), 'utf8');
  assert.match(example, /import \{ PreviewDirectionProvider \} from "\.\.\/PreviewDirection"/);
  assert.match(example, /<PreviewDirectionProvider>/);
  assert.match(example, /<MessageScrollerProvider>/);
  assert.match(await readFile(path.join(projectPath, 'src/components/examples/PreviewDirection.tsx'), 'utf8'), /export function usePreviewDirection/);
  assert.match(await readFile(path.join(projectPath, 'package.json'), 'utf8'), /"packageManager": "pnpm@12\.23\.0"/);
});

test('selects the pinned UI catalog for each base', () => {
  const common = shadcnRegistryItems('aria');
  const radix = shadcnRegistryItems('radix');
  const base = shadcnRegistryItems('base');
  assert.equal(new Set(common).size, 62);
  assert.deepEqual(
    radix.filter((item) => !common.includes(item)),
    ['menubar', 'navigation-menu'],
  );
  assert.deepEqual(
    base.filter((item) => !radix.includes(item)),
    ['toast'],
  );
  assert.equal(new Set(radix).size, 64);
  assert.equal(new Set(base).size, 65);
  for (const item of ['attachment', 'code-block', 'direction', 'form', 'message-scroller', 'native-select', 'sonner'] as const) {
    assert.ok(common.includes(item));
  }
});

test('refuses to publish when shadcn reports success but omits a registry source', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  const fixture = cliFixture(request, undefined, async (directory) => {
    await rm(path.join(directory, 'src/components/ui/message-scroller.tsx'));
  });
  await assert.rejects(
    createShadcnStarter(request, () => undefined, fixture.run),
    /shadcn did not install these components: message-scroller/,
  );
  assert.deepEqual(await readdir(parent), []);
  assert.equal(fixture.calls.length, 4);
});

test('preserves a target that is claimed during install and removes only the temporary stage', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  const target = path.join(parent, request.name);
  const fixture = cliFixture(request, undefined, async () => {
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), 'I am already here');
  });
  await assert.rejects(
    createShadcnStarter(request, () => undefined, fixture.run),
    /already exists/,
  );
  assert.deepEqual(await readdir(parent), [request.name]);
  assert.deepEqual(await readdir(target), ['keep.txt']);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'I am already here');
});

test('opens the canonical path when the chosen parent is a symlink', { skip: process.platform === 'win32' }, async (context) => {
  const parent = await parentFolder(context);
  const target = path.join(parent, 'destination');
  const alias = path.join(parent, 'alias');
  await mkdir(target);
  await symlink(target, alias);
  const request = requestAt(alias);
  const fixture = cliFixture(request);
  const { projectPath } = await createShadcnStarter(request, () => undefined, fixture.run);
  assert.equal(projectPath, path.join(await realpath(target), request.name));
  assert.deepEqual(await readdir(target), [request.name]);
});

test('concurrent attempts cannot publish twice to the same destination', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  const first = cliFixture(request);
  const second = cliFixture(request);
  const outcomes = await Promise.allSettled([
    createShadcnStarter(request, () => undefined, first.run),
    createShadcnStarter(request, () => undefined, second.run),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const refused = outcomes.find(({ status }) => status === 'rejected');
  assert.ok(refused !== undefined);
  assert.ok(refused.status === 'rejected');
  const reason: unknown = refused.reason;
  assert.ok(reason instanceof Error);
  assert.match(reason.message, /already exists/);
  assert.deepEqual(await readdir(parent), [request.name]);
});

test('leaves the final site absent after an install failure or a mismatched manager', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  const failed = cliFixture(request, undefined, async () => {
    throw new Error('install timed out');
  });
  await assert.rejects(
    createShadcnStarter(request, () => undefined, failed.run),
    /shadcn add failed.*timed out/,
  );
  assert.deepEqual(await readdir(parent), []);
  const mismatch = cliFixture(request, 'package-lock.json');
  await assert.rejects(
    createShadcnStarter(request, () => undefined, mismatch.run),
    /did not install.*pnpm/,
  );
  assert.deepEqual(await readdir(parent), []);
  assert.equal(mismatch.calls.length, 2);
});

test('refuses a dangling destination link before any tools or temporary files', { skip: process.platform === 'win32' }, async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  await symlink(path.join(parent, 'absent'), path.join(parent, request.name));
  const fixture = cliFixture(request);
  await assert.rejects(
    createShadcnStarter(request, () => undefined, fixture.run),
    /already exists/,
  );
  assert.deepEqual(await readdir(parent), [request.name]);
  assert.deepEqual(fixture.calls, []);
});

test('refuses missing tools and invalid presets before writing a temporary project', async (context) => {
  const parent = await parentFolder(context);
  const request = requestAt(parent);
  await assert.rejects(
    createShadcnStarter(
      request,
      () => undefined,
      async () => {
        throw new Error('pnpm could not be found');
      },
    ),
    /pnpm could not be found/,
  );
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(
    createShadcnStarter(
      request,
      () => undefined,
      async (_command, argumentsList) => {
        if (argumentsList[0] === '--version') {
          return '12.23.0';
        }
        throw new Error('Invalid preset code');
      },
    ),
    /Could not verify the shadcn preset.*Invalid preset code/,
  );
  assert.deepEqual(await readdir(parent), []);
});

test('a stopped staged command settles after the process exits', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  let processId: number | undefined;
  const command = runCreateCommand(
    process.execPath,
    ['-e', 'console.log(process.pid); setInterval(() => undefined, 5_000);'],
    os.tmpdir(),
    (output) => {
      processId = Number(output.trim());
      controller.abort();
    },
    { signal: controller.signal, waitForStop: true, timeoutMs: 5_000 },
  );
  await assert.rejects(command, { message: RUN_CANCELLED });
  const stoppedProcessId = processId;
  assert.ok(stoppedProcessId !== undefined);
  assert.throws(() => process.kill(stoppedProcessId, 0), { code: 'ESRCH' });
});

test('a staged command can cap its forwarded output', async () => {
  const chunks: string[] = [];
  await assert.rejects(
    runCreateCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));'], os.tmpdir(), (text) => chunks.push(text), {
      outputBytesMax: 128,
      timeoutMs: 5_000,
      waitForStop: true,
    }),
    /exceeded its command output limit/,
  );
  assert.deepEqual(chunks, []);
});
