import { assert } from '../../shared/core/assert';

// The pinned Create entry points are static JSX grids. Generate Astro
// components for their layout and cards so Stacki can round-trip those nodes.
export function shadcnEditableGallery(
  sources: Readonly<Record<string, string>>,
  options: { readonly style: string; readonly tooltip: boolean },
): Readonly<Record<string, string>> {
  const index = sources['index.tsx'];
  assert(index !== undefined, 'The shadcn gallery has an upstream entry point.');
  const markup = /export default function \w+\(\) \{\n  return \(\n([\s\S]+)\n  \)\n\}\s*$/.exec(index)?.[1];
  assert(markup !== undefined, 'The shadcn gallery entry point has a static layout.');
  const cards = [...index.matchAll(/^import \{ (\w+) \} from "(?:[^"]*\/)?cards\/([\w-]+)"$/gm)];
  assert(cards.length > 0, 'The shadcn gallery layout has card imports.');
  const files: Record<string, string> = {};
  const imports = cards.map(([, name, file]) => {
    assert(name !== undefined, 'A shadcn gallery card has a component name.');
    assert(file !== undefined, 'A shadcn gallery card has a filename.');
    const componentPath = `cards/${file}.tsx`;
    const source = sources[componentPath];
    assert(source !== undefined, `The gallery includes the source for ${name}.`);
    const card = editableCard(source, { name, file, tooltip: options.tooltip });
    files[componentPath] = card.island;
    files[`cards/${file}.astro`] = card.astro;
    return `import ${name} from "./cards/${file}.astro";`;
  });
  files['Gallery.astro'] = `---
${imports.join('\n')}
---

<div class="shadcn-gallery-frame" data-style=${JSON.stringify(options.style)}>
${markup.replaceAll('className=', 'class=').replace('overflow-x-auto overflow-y-hidden ', '').replace('[scrollbar-gutter:stable] ', '').replace(/^ {2}/gm, '')}
</div>

<style is:global>
  @layer components {
    .shadcn-gallery-frame {
      --gallery-radius: 24px;
      block-size: 100%;
    }
    .shadcn-gallery-frame > div {
      block-size: 100%;
      border-radius: var(--gallery-radius);
      overflow: auto;
      scrollbar-gutter: stable;
    }
  }
</style>
`;
  return files;
}

function editableCard(
  source: string,
  options: { readonly name: string; readonly file: string; readonly tooltip: boolean },
): { readonly astro: string; readonly island: string } {
  const { name, file, tooltip } = options;
  const entry = `export function ${name}()`;
  const start = source.indexOf(entry);
  assert(start >= 0, `The gallery card ${name} has a known component signature.`);
  const before = source.slice(0, start);
  const body = source.slice(start + entry.length);

  // Keep React's controls and context together. Named Astro slots move the
  // card's literal copy into Stacki's source tree without changing its look.
  const copy: { readonly slot: string; readonly text: string }[] = [];
  const markup = body.replace(
    /<(CardTitle|CardDescription|EmptyTitle|EmptyDescription|ItemTitle|ItemDescription|Button|FieldLabel|Label|div|p|span|h[1-6])(\s+[\w:-]+(?:="[^"]*")?)*\s*>([^<>{}]+)<\/\1>/g,
    (match: string, _tag: string, _attributes: string | undefined, text: string) => {
      const content = text.trim();
      if (content === '') {
        return match;
      }
      const slot = `copy${copy.length + 1}`;
      copy.push({ slot, text: content.replace(/\s+/g, ' ') });
      const opening = match.slice(0, match.indexOf('>') + 1);
      const closing = match.slice(match.lastIndexOf('<'));
      return `${opening}{${slot}}${closing}`;
    },
  );

  // Astro supplies named slots at render time, outside the JSX prop check.
  const copyType = copy.length === 0 ? '' : `type EditableCopy = {\n${copy.map(({ slot }) => `  readonly ${slot}?: GalleryCopyNode;\n`).join('')}};\n\n`;
  const props = copy.length === 0 ? '' : `{ ${copy.map(({ slot }) => slot).join(', ')} }: EditableCopy`;
  const copyImport = copy.length === 0 ? '' : 'import type { ReactNode as GalleryCopyNode } from "react";\n';
  const tooltipImport = tooltip ? 'import { TooltipProvider } from "@/components/ui/tooltip";\n' : '';
  const cardElement = copy.length === 0 ? `<${name} />` : `<${name} {...props} />`;
  const render = tooltip ? `<TooltipProvider>${cardElement}</TooltipProvider>` : cardElement;
  const slots = copy.map(({ slot, text }) => `    <span slot="${slot}">${text}</span>`).join('\n');
  return {
    astro: `---
import { EditableCard as CardControls } from "./${file}.tsx";
---

<article class="min-w-0">
${slots === '' ? '  <CardControls client:load />' : `  <CardControls client:load>\n${slots}\n  </CardControls>`}
</article>
`,
    island: `${before}import { PreviewDirectionProvider } from "../../PreviewDirection";
${copyImport}${tooltipImport}
${copyType}function ${name}(${props})${markup.trimEnd()}

export function EditableCard(${copy.length === 0 ? '' : 'props: EditableCopy'}) {
  return <PreviewDirectionProvider>${render}</PreviewDirectionProvider>;
}
`,
  };
}
