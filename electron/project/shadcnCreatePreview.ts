// Adapt the published Create preview to the Astro starter's local components.
import type { ShadcnBase, ShadcnIconLibrary } from '../../shared/ipc/shadcnStarter';
import { CREATE_PREVIEW_LICENSE, createPreviewSources } from './shadcnCreatePreviewSources';
import { createStylePreviewSources } from './shadcnCreateStylePreviewSources';
import { shadcnEditableGallery } from './shadcnEditableGallery';
import { shadcnGalleryAuditFixes } from './shadcnGalleryAudits';

const DIRECTORY = 'src/components/examples/create-preview';
const STYLE_DIRECTORY = 'src/components/examples/create-style-preview';

const ICON_PACKAGES: Readonly<Record<ShadcnIconLibrary, string>> = {
  lucide: 'lucide-react',
  tabler: '@tabler/icons-react',
  hugeicons: '@hugeicons/core-free-icons',
  phosphor: '@phosphor-icons/react',
  remixicon: '@remixicon/react',
};

export const SHADCN_GALLERY_TITLES = { guide: 'Style Gallery', examples: 'Component Gallery' } as const;
const GALLERY_DESCRIPTIONS = {
  guide: 'Explore the typography, color tokens, and design system patterns used across this shadcn starter.',
  examples: 'Browse interactive shadcn examples for forms, charts, tables, and other common interface patterns.',
} as const;
export const SHADCN_CREATE_PREVIEW_PAGE = previewPage({ page: 'examples', directory: DIRECTORY });
export const SHADCN_CREATE_STYLE_PREVIEW_PAGE = previewPage({ page: 'guide', directory: STYLE_DIRECTORY });

function previewPage({ page, directory }: { readonly page: keyof typeof SHADCN_GALLERY_TITLES; readonly directory: string }): string {
  const title = SHADCN_GALLERY_TITLES[page];
  return `---
import Layout from "@/layouts/main.astro";
import Gallery from "@/${directory.slice('src/'.length)}/Gallery.astro";
---

<Layout title="${title}" page="${page}" description="${GALLERY_DESCRIPTIONS[page]}">
  <h1 class="sr-only">${title}</h1>
  <div class="h-full min-w-0" role="region" aria-label="${title}">
    <Gallery />
  </div>
</Layout>

`;
}

export function shadcnCreatePreviewFiles(config: {
  readonly base: ShadcnBase;
  readonly iconLibrary: ShadcnIconLibrary;
  readonly style: string;
}): Readonly<Record<string, string>> {
  const { base, iconLibrary, style } = config;
  const galleries = [
    { directory: DIRECTORY, sources: createPreviewSources(base) },
    { directory: STYLE_DIRECTORY, sources: createStylePreviewSources(base) },
  ];
  return {
    ...Object.fromEntries<string>(
      galleries.flatMap(({ directory, sources }) => {
        const adapted = Object.fromEntries(
          Object.entries(sources).map(([file, source]) => [file, withLocalIcons(withPreviewStyles(shadcnGalleryAuditFixes(file, source)), iconLibrary)]),
        );
        const gallery = shadcnEditableGallery(adapted, { style, tooltip: directory === STYLE_DIRECTORY && base !== 'aria' });
        return Object.entries(gallery).map(([file, source]) => [`${directory}/${file}`, source] as const);
      }),
    ),
    [`${DIRECTORY}/style.ts`]: styleSource(style),
    [`${STYLE_DIRECTORY}/style.ts`]: STYLE_PREVIEW_TYPOGRAPHY,
    [`${DIRECTORY}/LICENSE`]: CREATE_PREVIEW_LICENSE,
    [`${STYLE_DIRECTORY}/LICENSE`]: CREATE_PREVIEW_LICENSE,
  };
}

function styleSource(style: string): string {
  return `// The standalone gallery uses the starter's preset instead of Create's URL state.
export function useDesignSystemSearchParams() {
  return [{ style: ${JSON.stringify(style)} }] as const;
}
`;
}

const STYLE_PREVIEW_TYPOGRAPHY = `import { useEffect, useState } from "react";
import { useDesignSystemSearchParams } from "../create-preview/style";

export { useDesignSystemSearchParams };

export function usePreviewTypography() {
  const [{ style }] = useDesignSystemSearchParams();
  const [fonts, setFonts] = useState<{ readonly body: string; readonly heading: string | undefined }>({
    body: "Default",
    heading: undefined,
  });
  useEffect(() => {
    // Read the installed theme's actual font variables, which can differ across presets.
    const theme = getComputedStyle(document.body);
    const body = firstFont(theme.getPropertyValue("--font-sans")) || "Default";
    const heading = firstFont(theme.getPropertyValue("--font-heading"));
    setFonts({ body, heading: heading && heading !== body ? heading : undefined });
  }, []);
  return { style: style.charAt(0).toUpperCase() + style.slice(1), ...fonts };
}

function firstFont(value: string): string {
  return (value.split(",", 1)[0] ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/ Variable$/, "");
}
`;

function withPreviewStyles(source: string): string {
  // The preset selectors compile in the site's existing Tailwind entry.
  return source
    .replace(/\bstyle-([a-z]+):/g, '[&:where([data-style=$1]_*)]:')
    .replace(/\b3xl:/g, 'min-[1600px]:')
    .replaceAll('cn-font-heading', 'font-heading');
}

function withLocalIcons(source: string, library: ShadcnIconLibrary): string {
  const imports = new Map<string, string>();
  const output = source.replace(/<IconPlaceholder\s+([\s\S]*?)\/>/g, (_full, props: string) => {
    const name = new RegExp(`\\b${library}="([A-Za-z][A-Za-z0-9]*)"`).exec(props)?.[1];
    if (name === undefined) {
      throw new Error(`The shadcn Create preview is missing an icon for ${library}.`);
    }
    const local = imports.get(name) ?? `CreateIcon${imports.size}`;
    imports.set(name, local);
    const attributes = props.replace(/\b(?:lucide|tabler|hugeicons|phosphor|remixicon)="[^"]*"\s*/g, '').trim();
    if (library === 'hugeicons') {
      return `<HugeiconsIcon icon={${local}} ${attributes} />`;
    }
    return `<${local} ${attributes} />`;
  });
  if (imports.size === 0) {
    return output;
  }
  const icons = [...imports].map(([name, local]) => `${name} as ${local}`).join(', ');
  // Preserve React's client directive above the added imports.
  const client = output.startsWith('"use client"') ? '"use client"\n' : '';
  const content = client === '' ? output : output.slice('"use client"'.length);
  const hugeicons = library === 'hugeicons' ? 'import { HugeiconsIcon } from "@hugeicons/react";\n' : '';
  return `${client}${hugeicons}import { ${icons} } from "${ICON_PACKAGES[library]}";\n${content}`;
}
