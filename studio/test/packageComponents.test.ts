// Goal: a thin project discovers and inserts installed components without copying or editing them.
// Method: use real temporary files, imported prop types, a linked package, and source-preserving edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanProject, safePath } from '../src/features/project/projectServer';
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { componentInsertionEdits } from '../src/features/source/componentInsertion';
import { applyEdits } from '../src/features/source/source';
import { componentAt } from '../src/features/project/componentEntry';
import { parseProject } from '../src/features/project/projectClient';
import { parsePage } from '../src/features/source/source';
import { scanComponentUsage } from '../src/features/components/componentUsageServer';
import { componentSpecifier } from '../vendor/stacki/electron/properties/componentImports';
import { componentPreviewURL } from '../vendor/stacki/src/features/palette/paletteModel';
import {
  packageComponentFiles,
  readPackageSource,
} from '../vendor/stacki/electron/lib/componentSources';

const file = 'node_modules/@ffnext/site-kit/src/lumos/components/Button.astro';
const component =
  '---\nimport type { ButtonProps } from "../types";\ninterface Props extends ButtonProps {}\nconst { variant = "primary" } = Astro.props;\n---\n<button data-variant={variant}><slot /></button>';

test('package preview links retain identity across Desktop and Studio path formats', () => {
  for (const componentPath of [
    file,
    '/project/' + file,
    'C:\\project\\' + file.replaceAll('/', '\\'),
  ]) {
    const url = new URL(
      componentPreviewURL(
        'http://localhost:4321',
        {
          path: componentPath,
          name: 'Button',
          folder: '../../node_modules/@ffnext/site-kit/src/lumos/components',
          origin: {
            kind: 'package',
            package: '@ffnext/site-kit',
            importPath: '@/components/Button.astro',
          },
        },
        'always',
      ),
    );
    assert.equal(url.searchParams.get('p'), file);
    assert.equal(url.pathname, '/__avb/preview/');
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-package-'));
  await mkdir(path.join(root, '.stacki'), { recursive: true });
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(
    path.join(root, '.stacki/component-sources.json'),
    JSON.stringify({
      version: 1,
      sources: [
        {
          kind: 'package',
          package: '@ffnext/site-kit',
          directory: 'src/lumos/components',
          importPrefix: '@/components/',
        },
      ],
    }),
  );
  await writeFile(path.join(root, file), component);
  await writeFile(
    path.join(root, 'node_modules/@ffnext/site-kit/src/lumos/types.ts'),
    'export interface ButtonProps { variant?: "primary" | "secondary"; disabled?: boolean; }',
  );
  await writeFile(
    path.join(root, 'src/pages/index.astro'),
    '---\nimport Button from "@/components/Button.astro";\n---\n<Button variant="secondary" />',
  );
  return root;
}

test('package scan resolves schemas, instance identity and usage without local copies', async () => {
  const root = await fixture();
  try {
    const project = await scanProject(root);
    const button = project.components.find((entry) => entry.file === file);
    assert.equal(button?.importPath, '@/components/Button.astro');
    assert.equal(button?.origin?.kind, 'package');
    assert.deepEqual(button?.fields.find((field) => field.name === 'variant')?.options, [
      'primary',
      'secondary',
    ]);
    const source = await readFile(path.join(root, 'src/pages/index.astro'), 'utf8');
    const parsed = parsePage(source);
    assert.equal(
      componentAt(parseProject(project), 'src/pages/index.astro', parsed, 'n0')?.file,
      file,
    );
    assert.equal((await scanComponentUsage(root, file))[0]?.total, 1);
    await assert.rejects(safePath(root, file), /Invalid project path/);
    assert.equal(await readFile(path.join(root, file), 'utf8'), component);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested insertion recipes retain package imports and unrelated page bytes', async () => {
  const root = await fixture();
  try {
    const icon = file.replace('Button', 'Icon');
    await writeFile(path.join(root, icon), '<svg><slot /></svg>');
    await writeFile(
      path.join(root, '.stacki/components.json'),
      JSON.stringify({
        version: 1,
        components: {
          [file]: {
            props: { variant: 'secondary' },
            children: [{ component: icon }, { literal: 'Continue' }],
          },
        },
      }),
    );
    const settings = await loadInsertionDefaults(root);
    const source = '<!-- Keep this comment exactly. -->\n';
    const edits = componentInsertionEdits(
      source,
      {
        kind: 'insert',
        name: 'Button',
        importPath: '@/components/Button.astro',
        paired: true,
        target: 'n0',
        placement: 'after',
      },
      'src/pages/index.astro',
      settings,
    );
    const result = applyEdits(source, edits);
    assert.match(result, /from "@\/components\/Button.astro"/);
    assert.match(result, /variant="secondary"/);
    assert.match(result, /from "@\/components\/Icon.astro"/);
    assert.match(result, /<Icon[\s/>]/);
    assert.ok(result.includes('Continue'));
    assert.ok(result.includes('<!-- Keep this comment exactly. -->'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an alias for installed components cannot silently select a local copy', async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, 'src/components'));
    await writeFile(path.join(root, 'src/components/Button.astro'), '<button>Local</button>');
    await writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    assert.equal(componentSpecifier(root, file), '@/components/Button.astro');
    assert.equal(componentSpecifier(root, 'src/components/Button.astro'), undefined);
    await writeFile(path.join(root, 'src/components/Local.astro'), '<div />');
    // The explicit package prefix still owns this namespace even when its file is missing.
    assert.equal(componentSpecifier(root, 'src/components/Local.astro'), undefined);
    await writeFile(
      path.join(root, '.stacki/component-sources.json'),
      '{"version":1,"sources":[]}',
    );
    assert.equal(
      componentSpecifier(root, 'src/components/Local.astro'),
      '@/components/Local.astro',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configured package links are readable but internal escaping links fail closed', async () => {
  const root = await fixture();
  const linked = await mkdtemp(path.join(os.tmpdir(), 'stacki-linked-'));
  try {
    await mkdir(path.join(linked, 'src/lumos/components'), { recursive: true });
    await writeFile(path.join(linked, 'src/lumos/components/Link.astro'), '<a><slot /></a>');
    await rm(path.join(root, 'node_modules/@ffnext/site-kit'), { recursive: true });
    await symlink(linked, path.join(root, 'node_modules/@ffnext/site-kit'), 'dir');
    assert.equal(packageComponentFiles(root).length, 1);
    assert.equal(readPackageSource(root, file.replace('Button', 'Link')), '<a><slot /></a>');
    await symlink(
      path.join(root, 'src/pages/index.astro'),
      path.join(linked, 'src/lumos/components/Escape.astro'),
    );
    assert.throws(() => packageComponentFiles(root), /Links within/);
    assert.throws(() => readPackageSource(root, file.replace('Button', 'Escape')), /Links within/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});
