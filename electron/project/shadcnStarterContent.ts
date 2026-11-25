import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toRecord } from '../../shared/core/record';
import { SHADCN_BASES, SHADCN_ICON_LIBRARIES, type ShadcnBase, type ShadcnIconLibrary } from '../../shared/ipc/shadcnStarter';
import { COMPONENT_DEFAULTS_FILE, parseComponentDefaults, type ComponentRecipe } from '../../shared/properties/componentDefaults';
import { SHADCN_DIRECTION_BOOTSTRAP, SHADCN_DIRECTION_STORAGE_PREFIX, shadcnPreviewDirection } from './shadcnStarterDirection';
import { SHADCN_THEME_BOOTSTRAP, shadcnThemePicker } from './shadcnStarterTheme';
import { shadcnStarterSiteFiles } from './shadcnStarterSite';
import { SHADCN_CREATE_PREVIEW_PAGE, SHADCN_CREATE_STYLE_PREVIEW_PAGE, SHADCN_GALLERY_TITLES, shadcnCreatePreviewFiles } from './shadcnCreatePreview';

const COMPONENTS_DIRECTORY = 'src/components';
const STARTER_CONFIG_BYTES_MAX = 16_384;

/** Writes into the new standalone Astro project after shadcn has installed its registry sources. */
export async function writeShadcnStarterContent(directory: string, options: { readonly rtl: boolean }): Promise<void> {
  const config = await readStarterConfig(directory);
  const { base } = config;
  const defaults = parseComponentDefaults({
    version: 1,
    components: Object.fromEntries(Object.entries(COMPONENTS).map(([name, { recipe }]) => [componentFile(name), recipe])),
  });

  const files = {
    'src/layouts/main.astro': shadcnStarterLayout(base, options),
    'src/pages/index.astro': SHADCN_CREATE_STYLE_PREVIEW_PAGE,
    'src/pages/example-components.astro': SHADCN_CREATE_PREVIEW_PAGE,
    ...shadcnStarterSiteFiles(),
    ...shadcnCreatePreviewFiles(config),
    'src/components/examples/ThemePicker.tsx': shadcnThemePicker(base, options),
    'src/components/examples/PreviewDirection.tsx': shadcnPreviewDirection(base),
    'src/components/examples/DialogExample.tsx': dialogExample(base),
    'src/components/examples/TabsExample.tsx': tabsExample(base),
    [COMPONENT_DEFAULTS_FILE]: JSON.stringify(defaults, null, 2) + '\n',
    ...Object.fromEntries(Object.entries(COMPONENTS).map(([name, { source }]) => [componentFile(name), source])),
  };

  // The tree has a fixed number of files. Keep this content in the compiled
  // Electron module so the desktop package needs no separate template assets.
  const writes = await Promise.allSettled(
    Object.entries(files).map(async ([relative, source]) => {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, 'utf8');
    }),
  );
  // Drain every write before the caller can remove the temporary project.
  for (const write of writes) {
    if (write.status === 'rejected') {
      const error: unknown = write.reason;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

async function readStarterConfig(directory: string): Promise<{ readonly base: ShadcnBase; readonly iconLibrary: ShadcnIconLibrary; readonly style: string }> {
  const file = await open(path.join(directory, 'components.json'), 'r');
  try {
    const buffer = Buffer.alloc(STARTER_CONFIG_BYTES_MAX + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > STARTER_CONFIG_BYTES_MAX) {
      throw new Error('The generated shadcn configuration exceeds its size limit.');
    }
    const input: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    const config = toRecord(input);
    const style = config?.['style'];
    // The CLI uses the base as the style prefix, including for custom presets.
    const basePrefix = typeof style === 'string' ? /^([a-z]+)-[a-z]+$/.exec(style)?.[1] : undefined;
    const base = SHADCN_BASES.find((candidate) => candidate === basePrefix);
    const iconLibrary = SHADCN_ICON_LIBRARIES.find((candidate) => candidate === config?.['iconLibrary']);
    if (base === undefined) {
      throw new Error('The generated shadcn configuration has an unsupported base.');
    }
    if (iconLibrary === undefined) {
      throw new Error('The generated shadcn configuration has an unsupported icon library.');
    }
    return { base, iconLibrary, style: typeof style === 'string' ? style.slice(base.length + 1) : '' };
  } finally {
    await file.close();
  }
}

function componentFile(name: string): string {
  return `${COMPONENTS_DIRECTORY}/${name}.astro`;
}

// Selectors refer to native theme classes from the registry so both modes use
// the author's custom properties and the same stylesheet.
export function shadcnStarterLayout(base: ShadcnBase, { rtl }: { readonly rtl: boolean }): string {
  return `---
import "@/styles/global.css";
import { ThemePicker } from "@/components/examples/ThemePicker";

interface Props {
  readonly title: string;
  readonly description: string;
  readonly page?: "guide" | "examples";
}

const { title, description, page } = Astro.props;
const base = import.meta.env.BASE_URL.replace(/\\/$/, "");
const path = Astro.url.pathname;
const canonical = Astro.site ? new URL(path, Astro.site).href : path;
const imagePath = base + "/gallery-social.png";
const socialImage = Astro.site ? new URL(imagePath, Astro.site).href : imagePath;
const structuredData = JSON.stringify({
  "@context": "https://schema.org",
  "@type": page === undefined ? "WebPage" : "CollectionPage",
  name: title,
  description,
  ...(Astro.site ? { url: canonical } : {}),
}).replace(/</g, "\\\\u003c");
---

<!doctype html>
<html lang="en" dir="ltr"${rtl ? ` data-preview-direction-key={"${SHADCN_DIRECTION_STORAGE_PREFIX}" + (base || "/")}` : ''}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:image" content={socialImage} />
    <meta property="og:image:alt" content="Illustrated cards from the shadcn gallery" />
    <script is:inline type="application/ld+json" set:html={structuredData}></script>
    <script is:inline>
${SHADCN_THEME_BOOTSTRAP.trimEnd()}${rtl ? SHADCN_DIRECTION_BOOTSTRAP.trimEnd() : ''}
    </script>
  </head>
  <body class="flex h-dvh flex-col bg-background font-sans text-foreground">
    <header class="shrink-0 border-b border-border">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pb-2 pt-1 sm:px-8 sm:py-0">
        <nav aria-label="Starter pages" class="shadcn-starter-nav flex flex-wrap gap-x-6 text-sm">
          <a href={base + "/"} aria-current={page === "guide" ? "page" : undefined} class="nav-link">${SHADCN_GALLERY_TITLES.guide}</a>
          <a href={base + "/example-components/"} aria-current={page === "examples" ? "page" : undefined} class="nav-link">${SHADCN_GALLERY_TITLES.examples}</a>
        </nav>
        <ThemePicker client:load />
      </div>
    </header>
    <main class="min-h-0 min-w-0 flex-1 p-4">
      <slot />
    </main>
  </body>
</html>

<style is:global>
  @layer components {
    .shadcn-starter-nav .nav-link {
      --gallery-tab-height: 3.5rem;
      --gallery-tab-indicator: 2px;
      align-content: center;
      min-block-size: var(--gallery-tab-height);
      border-block-end: var(--gallery-tab-indicator) solid transparent;
      color: var(--muted-foreground);
    }
    .shadcn-starter-nav .nav-link:hover, .shadcn-starter-nav .nav-link[aria-current="page"] {
      color: var(--foreground);
    }
    .shadcn-starter-nav .nav-link[aria-current="page"] {
      border-block-end-color: var(--primary);
    }
    html.dark {
      color-scheme: dark;
    }${rtl && base === 'radix' ? RADIX_DIRECTION_BEFORE_HYDRATION : ''}
  }
</style>

`;
}

const RADIX_DIRECTION_BEFORE_HYDRATION = `
  /* Let the saved page direction lay out Radix's server-rendered controls until their React providers start. */
  html[dir="rtl"] astro-island[ssr] :is([data-slot="tabs"], [data-slot="toggle-group"])[dir="ltr"] {
    direction: inherit;
  }`;

const COMPONENTS = {
  Button: {
    recipe: { props: { label: 'Button text', variant: 'default' } },
    source: `---
import { Button as ButtonRoot } from "./ui/button";

interface Props {
  readonly label?: string;
  readonly variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
  readonly type?: "button" | "submit" | "reset";
  readonly class?: string;
}

const { label = "Button text", variant = "default", type = "button", class: className } = Astro.props;
---

<ButtonRoot {variant} {type} {className}>{label}</ButtonRoot>
`,
  },
  Card: {
    recipe: {
      props: { heading: 'Open tasks', description: 'Across active projects' },
      children: [{ element: 'p', props: { class: 'text-3xl font-semibold tabular-nums' }, text: '12' }],
    },
    source: `---
import { Card as CardRoot, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./ui/card";

interface Props {
  readonly heading?: string;
  readonly description?: string;
  readonly class?: string;
}

const { heading = "Open tasks", description = "Across active projects", class: className } = Astro.props;
---

<CardRoot {className}>
  <CardHeader>
    <CardTitle>{heading}</CardTitle>
    {description && <CardDescription>{description}</CardDescription>}
  </CardHeader>
  <CardContent><slot /></CardContent>
  {Astro.slots.has("footer") && <CardFooter><slot name="footer" /></CardFooter>}
</CardRoot>
`,
  },
  Dialog: {
    recipe: { props: { trigger: 'Open dialog' } },
    source: `---
import { DialogExample } from "./examples/DialogExample";

interface Props {
  readonly trigger?: string;
  readonly heading?: string;
  readonly description?: string;
}

const { trigger, heading, description } = Astro.props;
---

<DialogExample client:load {trigger} {heading} {description} />
`,
  },
  Field: {
    recipe: {
      props: { label: 'Project name' },
      // The enclosing Field supplies the accessible name.
      children: [{ component: componentFile('Input'), inherit: false, props: { name: 'projectName', value: 'Field notes' } }],
    },
    source: `---
import { Field as FieldRoot, FieldLabel } from "./ui/field";

interface Props {
  readonly label?: string;
  readonly class?: string;
}

const { label = "Project name", class: className } = Astro.props;
---

<FieldRoot {className}>
  <FieldLabel className="w-full flex-col items-stretch">
    <span>{label}</span>
    <slot />
  </FieldLabel>
</FieldRoot>
`,
  },
  Input: {
    recipe: { props: { name: 'example', label: 'Example input', placeholder: 'Type here' } },
    source: `---
import { Input as InputRoot } from "./ui/input";

interface Props {
  readonly name?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly class?: string;
}

const { name, label, placeholder, value, required = false, class: className } = Astro.props;
---

<InputRoot type="text" {name} aria-label={label} {placeholder} defaultValue={value} {required} {className} />
`,
  },
  Tabs: {
    recipe: { props: { initialTab: 'recent' } },
    source: `---
import { TabsExample } from "./examples/TabsExample";

interface Props {
  readonly initialTab?: "recent" | "upcoming";
}

const { initialTab } = Astro.props;
---

<TabsExample client:load {initialTab} />
`,
  },
} satisfies Readonly<Record<string, { readonly source: string; readonly recipe: ComponentRecipe }>>;

function dialogExample(base: ShadcnBase): string {
  const trigger = '<Button variant="outline">{trigger}</Button>';
  const contents = `<DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>`;
  const composition =
    base === 'aria'
      ? `<DialogTrigger>
        ${trigger}
        <Dialog>${contents}</Dialog>
      </DialogTrigger>`
      : `<Dialog>
        ${base === 'base' ? '<DialogTrigger render={<Button variant="outline" />}>{trigger}</DialogTrigger>' : '<DialogTrigger asChild>' + trigger + '</DialogTrigger>'}
        <DialogContent>${contents}</DialogContent>
      </Dialog>`;
  return `import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, DialogTrigger${base === 'aria' ? '' : ', DialogContent'} } from "../ui/dialog";
import { PreviewDirectionProvider } from "./PreviewDirection";

interface Props {
  readonly trigger?: string;
  readonly heading?: string;
  readonly description?: string;
}

// Keep the trigger and overlay in one island so the dialog manages focus across both.
export function DialogExample({
  trigger = "View project details",
  heading = "Project details",
  description = "Field notes has 12 open tasks this week.",
}: Props) {
  return (
    <PreviewDirectionProvider>
      ${composition}
    </PreviewDirectionProvider>
  );
}
`;
}

function tabsExample(base: ShadcnBase): string {
  const defaultProp = base === 'aria' ? 'defaultSelectedKey' : 'defaultValue';
  const itemProp = base === 'aria' ? 'id' : 'value';
  return `import { PreviewDirectionProvider } from "./PreviewDirection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface Props {
  readonly initialTab?: "recent" | "upcoming";
}

// The tab list and panels share the registry's selection and keyboard behavior.
export function TabsExample({ initialTab = "recent" }: Props) {
  return (
    <PreviewDirectionProvider>
      <Tabs ${defaultProp}={initialTab} aria-label="Project activity">
        <TabsList variant="line">
          <TabsTrigger ${itemProp}="recent">Recent</TabsTrigger>
          <TabsTrigger ${itemProp}="upcoming">Upcoming</TabsTrigger>
        </TabsList>
        <TabsContent ${itemProp}="recent" className="py-2">
          <p>Project review finished on Monday.</p>
        </TabsContent>
        <TabsContent ${itemProp}="upcoming" className="py-2">
          <p>Review the remaining tasks on Thursday.</p>
        </TabsContent>
      </Tabs>
    </PreviewDirectionProvider>
  );
}
`;
}
