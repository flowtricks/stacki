// Generate into temporary CLI-shaped projects. Check the editor's actual prop
// and recipe parsers, and compare the registry-owned files before and after generation.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { defaultSlotInline, parseSlots } from '#dist/electron/parse/astroComponentApi.js';
import { readPropModel } from '#dist/electron/parse/propModel/readPropModel.js';
import { markSourceFile } from '#dist/electron/previewServer/previewMarkers.js';
import { writeShadcnStarterContent } from '#dist/electron/project/shadcnStarterContent.js';
import { COMPONENT_DEFAULTS_FILE, defaultsIssues, parseDefaultsSource, resolveComponentRecipe } from '#dist/shared/properties/componentDefaults.js';

const THEME = ':root { --primary: #8021c4; }\n.dark { --primary: #d4a6ec; }\n';
const EDITABLE_WRAPPERS = ['Button.astro', 'Card.astro', 'Dialog.astro', 'Field.astro', 'Input.astro', 'Tabs.astro'] as const;
const THEME_SELECTION = {
  base: /value=\{\[theme\]\} multiple=\{false\}/,
  aria: /selectionMode="single" disallowEmptySelection selectedKeys=\{\[theme\]\}/,
  radix: /type="single" value=\{theme\}/,
} as const;
const DIRECTION_PROVIDER = {
  base: /<DirectionProvider direction=\{direction\}>/,
  aria: /<DirectionProvider locale=\{direction === "rtl" \? "en-Arab" : "en"\}>/,
  radix: /<DirectionProvider dir=\{direction\}>/,
} as const;
const ASSEMBLIES = [
  { base: 'base', icons: 'lucide', importName: 'lucide-react', rtl: false, trigger: /DialogTrigger render=/, tabs: /defaultValue=\{initialTab\}/ },
  { base: 'radix', icons: 'tabler', importName: '@tabler/icons-react', rtl: true, trigger: /DialogTrigger asChild/, tabs: /defaultValue=\{initialTab\}/ },
  {
    base: 'aria',
    icons: 'hugeicons',
    importName: '@hugeicons/core-free-icons',
    rtl: true,
    trigger: /<DialogTrigger>\s*<Button/,
    tabs: /defaultSelectedKey=\{initialTab\}/,
  },
  { base: 'base', icons: 'phosphor', importName: '@phosphor-icons/react', rtl: true, trigger: /DialogTrigger render=/, tabs: /defaultValue=\{initialTab\}/ },
  {
    base: 'aria',
    icons: 'remixicon',
    importName: '@remixicon/react',
    rtl: false,
    trigger: /<DialogTrigger>\s*<Button/,
    tabs: /defaultSelectedKey=\{initialTab\}/,
  },
] as const;

for (const { base, icons, importName, rtl, trigger, tabs } of ASSEMBLIES) {
  test(`writes the ${base} starter with ${icons} and editable defaults`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'stacki-shadcn-content-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const config = JSON.stringify({ style: base + '-nova', iconLibrary: icons, rtl });
    await Promise.all(['src/styles', 'src/components/ui'].map((relative) => mkdir(path.join(directory, relative), { recursive: true })));
    await Promise.all([
      writeFile(path.join(directory, 'components.json'), config),
      writeFile(path.join(directory, 'src/styles/global.css'), THEME),
      writeFile(path.join(directory, 'src/components/ui/button.tsx'), 'registry Button\n'),
    ]);

    await writeShadcnStarterContent(directory, { rtl });

    const read = (file: string): Promise<string> => readFile(path.join(directory, file), 'utf8');
    assert.equal(await read('src/styles/global.css'), THEME);
    assert.equal(await read('components.json'), config);
    assert.equal(await read('src/components/ui/button.tsx'), 'registry Button\n');
    const [layout, guide, examples, dialog, tabExample, iconGrid, theme, styleGallery, gallery, contributionHistory, directionProvider, recipes] =
      await Promise.all([
        read('src/layouts/main.astro'),
        read('src/pages/index.astro'),
        read('src/pages/example-components.astro'),
        read('src/components/examples/DialogExample.tsx'),
        read('src/components/examples/TabsExample.tsx'),
        read('src/components/examples/create-style-preview/cards/icon-preview-grid.tsx'),
        read('src/components/examples/ThemePicker.tsx'),
        read('src/components/examples/create-style-preview/Gallery.astro'),
        read('src/components/examples/create-preview/Gallery.astro'),
        read('src/components/examples/create-preview/cards/contribution-history.tsx'),
        read('src/components/examples/PreviewDirection.tsx'),
        read(COMPONENT_DEFAULTS_FILE),
      ]);
    assert.match(layout, /import "@\/styles\/global\.css"/);
    assert.match(layout, /<html lang="en" dir="ltr"[ >]/);
    assert.equal(layout.includes('data-preview-direction-key={"shadcn-starter-direction:" + (base || "/")}'), rtl);
    assert.equal(layout.includes('html[dir="rtl"] astro-island[ssr]'), rtl && base === 'radix');
    assert.equal(theme.includes('aria-label="Text direction"'), rtl);
    assert.equal(theme.includes('>LTR</ToggleGroupItem>'), rtl);
    assert.equal(theme.includes('>RTL</ToggleGroupItem>'), rtl);
    const bootstrap = /<script is:inline>([\s\S]*?)<\/script>/.exec(layout)?.[1];
    assert.ok(bootstrap);
    for (const saved of [undefined, 'sideways', 'ltr', 'rtl', 'blocked']) {
      const directionKey = 'shadcn-starter-direction:/starter';
      const root = { dir: 'ltr', dataset: { previewDirectionKey: rtl ? directionKey : undefined }, classList: { toggle: () => undefined } };
      runInNewContext(bootstrap, {
        document: { documentElement: root },
        matchMedia: () => ({ matches: false }),
        localStorage: {
          getItem: (key: string) => {
            if (key === 'shadcn-starter-theme') {
              return undefined;
            }
            assert.equal(key, directionKey);
            if (saved === 'blocked') {
              throw new Error('Storage is blocked');
            }
            return saved;
          },
        },
        window: new EventTarget(),
        Event,
      });
      assert.equal(root.dir, rtl && saved === 'rtl' ? 'rtl' : 'ltr');
    }
    assert.match(guide, /<Layout title="Style Gallery" page="guide" description="/);
    assert.match(examples, /<Layout title="Component Gallery" page="examples" description="/);
    assert.match(layout, />Style Gallery<\/a>/);
    assert.match(layout, /<meta name="description" content=\{description\}/);
    assert.match(layout, /rel="canonical" href=\{canonical\}/);
    assert.match(layout, /property="og:image" content=\{socialImage\}/);
    assert.match(layout, /type="application\/ld\+json"/);
    assert.match(guide, /<h1 class="sr-only">Style Gallery<\/h1>/);
    assert.match(examples, /<h1 class="sr-only">Component Gallery<\/h1>/);
    assert.match(await read('src/pages/404.astro'), /<h1[^>]+>Page not found<\/h1>/);
    assert.match(await read('src/pages/sitemap.xml.ts'), /new URL\(base \+ route, origin\)/);
    assert.match(await read('src/pages/robots.txt.ts'), /User-agent:/);
    const socialImage = await readFile(path.join(directory, 'public/gallery-social.png'));
    assert.equal(socialImage.readUInt32BE(16), 1200);
    assert.equal(socialImage.readUInt32BE(20), 630);
    assert.match(await read('src/components/examples/create-preview/cards/recent-transactions.tsx'), /aria-label="Transaction options"/);
    assert.match(await read('src/components/examples/create-style-preview/cards/ui-elements.tsx'), /aria-label="Open quick actions"/);
    assert.match(layout, />Component Gallery<\/a>/);
    for (const source of [styleGallery, gallery]) {
      assert.match(source, /--gallery-radius: 24px;/);
      assert.match(source, /border-radius: var\(--gallery-radius\);/);
      assert.match(source, /<style is:global>\s+@layer components/);
    }
    assert.match(layout, /<ThemePicker client:load \/>/);
    assert.match(layout, /localStorage\.getItem\("shadcn-starter-theme"\)/);
    assert.match(theme, /import \{ ToggleGroup, ToggleGroupItem \} from "\.\.\/ui\/toggle-group"/);
    assert.match(theme, THEME_SELECTION[base]);
    assert.match(theme, /aria-label="Color theme"/);
    assert.match(guide, /create-style-preview\/Gallery/);
    assert.match(guide, /<Gallery \/>/);
    assert.match(styleGallery, /grid-cols-7/);
    assert.match(styleGallery, /<StyleOverview \/>/);
    assert.match(styleGallery, /<TypographySpecimen \/>/);
    assert.match(styleGallery, /<EnvironmentVariables \/>/);
    assert.match(styleGallery, /<BookAppointment \/>/);
    assert.match(examples, /<Gallery \/>/);
    assert.doesNotMatch(examples, /Workshop|gallery-card/);
    assert.match(gallery, /grid-cols-7/);
    assert.match(gallery, /<ContributionHistory \/>/);
    assert.match(gallery, /<PayoutThreshold \/>/);
    assert.match(gallery, /<RecentTransactions \/>/);
    const contributionCard = await read('src/components/examples/create-preview/cards/contribution-history.astro');
    const typographyCard = await read('src/components/examples/create-style-preview/cards/typography-specimen.astro');
    assert.match(contributionCard, /<span slot="copy1">Contribution History<\/span>/);
    assert.match(typographyCard, /<span slot="copy1">Designing with rhythm and hierarchy\.<\/span>/);
    for (const source of [guide, examples, styleGallery, gallery, contributionCard, typographyCard]) {
      assert.equal(parsePage(source, { locs: true }).editable, true);
    }
    for (const [file, copy] of [
      ['src/components/examples/create-preview/cards/contribution-history.astro', 'Contribution History'],
      ['src/components/examples/create-style-preview/cards/typography-specimen.astro', 'Designing with rhythm and hierarchy.'],
    ] as const) {
      const marked = markSourceFile(path.join(directory, file), [directory]);
      assert.ok(marked);
      assert.ok(marked.code.includes(`data-avb-p="${file}|`));
      assert.ok(marked.code.includes(copy));
    }
    assert.match(contributionHistory, /<CardTitle>\{copy1\}<\/CardTitle>/);
    assert.match(contributionHistory, /"var\(--chart-2\)"/);
    assert.match(dialog, trigger);
    assert.match(tabExample, tabs);
    for (const island of [dialog, tabExample, theme]) {
      assert.match(island, /<PreviewDirectionProvider>/);
    }
    assert.match(contributionHistory, /<PreviewDirectionProvider>/);
    assert.match(directionProvider, DIRECTION_PROVIDER[base]);
    assert.match(directionProvider, /function serverDirection\(\): Direction \{\s+return "ltr";/);
    assert.match(dialog, /heading = "Project details"/);
    assert.match(tabExample, /aria-label="Project activity"/);
    assert.ok(iconGrid.includes(`from "${importName}"`));
    const files = (await readdir(path.join(directory, 'src/components'))).filter((file) => file.endsWith('.astro'));
    assert.deepEqual(files.sort(), EDITABLE_WRAPPERS);

    const catalog = await Promise.all(
      files.map(async (name) => {
        const file = `src/components/${name}`;
        const source = await read(file);
        assert.doesNotMatch(source, /data-stacki|<stacki-/);
        return {
          file,
          name: path.basename(name, '.astro'),
          props: readPropModel(source).props.map((prop) => prop.name),
          slots: parseSlots(source),
          slotText: defaultSlotInline(source),
        };
      }),
    );
    const parsed = parseDefaultsSource(recipes);
    assert.ok(parsed.ok);
    assert.deepEqual(defaultsIssues(parsed.value, catalog), []);
    const button = resolveComponentRecipe('src/components/Button.astro', parsed.value, catalog);
    assert.ok(button.ok);
    assert.deepEqual(button.value.props, { label: 'Button text', variant: 'default' });
    const field = resolveComponentRecipe('src/components/Field.astro', parsed.value, catalog);
    assert.ok(field.ok);
    assert.deepEqual(field.value.content, {
      kind: 'children',
      children: [
        {
          component: 'src/components/Input.astro',
          props: { name: 'projectName', value: 'Field notes' },
          content: { kind: 'empty' },
        },
      ],
    });
  });
}

test('invalid registry settings fail before the starter writes files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stacki-shadcn-content-invalid-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'components.json');
  for (const [source, error] of [
    [JSON.stringify({ style: 'other-nova', iconLibrary: 'lucide' }), /unsupported base/],
    [JSON.stringify({ style: 'base-nova', iconLibrary: 'other' }), /unsupported icon library/],
    [' '.repeat(17_000), /exceeds its size limit/],
  ] as const) {
    await writeFile(file, source);
    await assert.rejects(writeShadcnStarterContent(directory, { rtl: false }), error);
    assert.deepEqual(await readdir(directory), ['components.json']);
  }
});
