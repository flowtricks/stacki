import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CreatePackageManager } from '../../shared/properties/packageManager';
import { componentVariables, HEROUI_THEME_FILE, heroUIThemeCSS } from './herouiStarterTheme';
import { styleGuide } from './herouiStarterSiteGuide';

// Registry integrity for the package tarballs audited for this template.
// @heroui/react: sha512-2Zz2ghu9mvi6MN1tAFrlXx10RYQYatw9u06/Co6L88uPTZ8bNM74qK1rQ3zYoFbRZ+JQfSAdMat7NvjjcB3IhA==
// @heroui/styles: sha512-66+qgy4Hj1llJHYQw4d7wM5+/lkZrAl0LFUcQZTo68VYOy2eVXzHc0IYKLDMz6sSlDfQfI/uDnuEFbcA0BAwCQ==.
export const HEROUI_VERSION = '3.2.8';

// The pinned Astro React integration requires a newer Node patch than Astro itself.
const NODE_VERSION_MINIMUM = '22.23.4';

// Match Studio's Astro version. Pin HeroUI's peers so npm and pnpm resolve
// the same React, React Aria and date APIs used by the generated examples.
const dependencies = {
  '@astrojs/react': '7.1.9',
  '@heroui/react': HEROUI_VERSION,
  '@heroui/styles': HEROUI_VERSION,
  '@internationalized/date': '3.12.4',
  '@react-aria/ssr': '3.10.1',
  '@react-aria/utils': '3.34.1',
  astro: '7.3.8',
  react: '19.3.1',
  'react-aria': '3.53.1',
  'react-aria-components': '1.22.1',
  'react-dom': '19.3.1',
  tailwindcss: '4.3.5',
} as const;

const devDependencies = {
  '@tailwindcss/vite': '4.3.5',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  // The Astro integration requires this peer to transform React JSX.
  'oxc-transform-react': '0.156.0',
} as const;

export function heroUISiteManifest(name: string, manager: CreatePackageManager, managerVersion: string) {
  // Folder names can begin with a dot or underscore. Registry names cannot.
  const packageName = name.toLowerCase().replace(/^[._-]+/, '') || 'heroui-site';
  return {
    name: packageName,
    private: true,
    version: '0.1.0',
    type: 'module',
    engines: { node: `>=${NODE_VERSION_MINIMUM}` },
    packageManager: `${manager}@${managerVersion}`,
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
    dependencies,
    devDependencies,
  };
}

export async function writeHeroUISite(directory: string, manifest: ReturnType<typeof heroUISiteManifest>, manager: CreatePackageManager): Promise<void> {
  const files = {
    'package.json': JSON.stringify(manifest, undefined, 2) + '\n',
    '.gitignore': gitignore,
    'README.md': siteReadme(manager),
    'astro.config.mjs': astroConfig,
    'tsconfig.json': tsconfig,
    'src/layouts/main.astro': layout,
    'src/pages/index.astro': styleGuide,
    'src/styles/global.css': globalCSS,
    [HEROUI_THEME_FILE]: heroUIThemeCSS(),
    // A local workspace keeps installs in the site even when the destination
    // is itself inside another workspace. Hoisted links survive a move on Windows.
    ...(manager === 'pnpm' ? { 'pnpm-workspace.yaml': 'packages: []\nnodeLinker: hoisted\n' } : {}),
  } as const;

  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, { encoding: 'utf8', flag: 'wx' });
  }
}

const astroConfig = `import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // Astro loads this CommonJS entry through the island client at runtime.
    // Prebundle it so editor previews receive the named React DOM exports.
    optimizeDeps: { include: ["react-dom/client"] },
  },
});
`;

const tsconfig = `{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
`;

const gitignore = `node_modules/
dist/
.astro/
.env
.env.*
!.env.example
.DS_Store
.stacki/preview/
`;

const layout = `---
import "../styles/global.css";

interface Props {
  readonly title: string;
}

const { title } = Astro.props;
const currentPath = Astro.url.pathname.replace(/\\/$/, "") || "/";
---

<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} | HeroUI</title>
    <script is:inline>
      // Apply the choice before paint, on the element shared by the page and its overlays.
      let theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      try {
        const saved = localStorage.getItem("stacki-heroui-theme");
        if (saved === "light" || saved === "dark") {
          theme = saved;
        }
      } catch {
        // Browser storage can be disabled, so the system preference is still usable.
      }
      document.documentElement.dataset.theme = theme;
    </script>
  </head>
  <body>
    <header class="site-header">
      <div class="site-header-inner">
        <nav aria-label="Site" class="site-navigation">
          <a href="/" aria-current={currentPath === "/" ? "page" : undefined}>Style Guide</a>
          <a href="/example-components/" aria-current={currentPath === "/example-components" ? "page" : undefined}>Example Components</a>
        </nav>
        <div role="group" aria-label="Color theme" class="theme-control">
          <button type="button" aria-pressed="true" data-set-theme="light">Light</button>
          <button type="button" aria-pressed="false" data-set-theme="dark">Dark</button>
        </div>
      </div>
    </header>
    <main><slot /></main>
    <script>
      const root = document.documentElement;
      const controls = document.querySelectorAll<HTMLButtonElement>("button[data-set-theme]");
      function syncThemeControls() {
        controls.forEach((control) => {
          control.setAttribute("aria-pressed", String(control.dataset.setTheme === root.dataset.theme));
        });
      }

      controls.forEach((control) => {
        control.addEventListener("click", () => {
          const theme = control.dataset.setTheme;
          if (theme !== "light" && theme !== "dark") {
            return;
          }
          root.dataset.theme = theme;
          syncThemeControls();
          try {
            localStorage.setItem("stacki-heroui-theme", theme);
          } catch {
            // The choice still applies in this page if storage is disabled.
          }
        });
      });
      syncThemeControls();
    </script>
  </body>
</html>
`;

const globalCSS = `@import "tailwindcss";
@import "@heroui/styles";
@import "./theme.css";

@layer base {
  body {
    min-height: 100vh;
    background: var(--background);
    color: var(--foreground);
    font-family: var(--font-sans);
  }
}

@layer components {
  .site-header {
    border-bottom: var(--border-width) solid var(--border);
    background: var(--surface);
    color: var(--surface-foreground);
  }

  .site-header-inner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    column-gap: calc(var(--spacing) * 6);
    row-gap: calc(var(--spacing) * 3);
    max-width: 72rem;
    margin-inline: auto;
    padding: calc(var(--spacing) * 3) clamp(1rem, 4vw, 2rem);
  }

  .site-navigation,
  .theme-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: calc(var(--spacing) * 1);
    font-size: 0.875rem;
  }

  .site-navigation a,
  .theme-control button {
    border-radius: var(--radius);
    padding: calc(var(--spacing) * 2) calc(var(--spacing) * 3);
    color: var(--muted);
  }

  .site-navigation a[aria-current="page"],
  .theme-control button[aria-pressed="true"] {
    background: var(--surface-secondary);
    color: var(--surface-secondary-foreground);
    font-weight: 600;
  }

  .site-navigation a:hover,
  .theme-control button:hover {
    color: var(--foreground);
  }

  .site-navigation a:focus-visible,
  .theme-control button:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: var(--ring-offset-width);
  }

  .theme-control button {
    cursor: var(--cursor-interactive);
  }
}
`;

function siteReadme(manager: CreatePackageManager): string {
  const componentOverrides = Object.entries(componentVariables)
    .map(([scope, variables]) => {
      const values = Object.entries(variables)
        .map(([name, value]) => `\`${name}: ${value}\``)
        .join(', ');
      return `- \`${scope}\`: ${values}.`;
    })
    .join('\n');
  return `# HeroUI Astro starter

Requires Node.js ${NODE_VERSION_MINIMUM} or later and ${manager}.

\`\`\`sh
${manager} install
${manager} run dev
${manager} run build
\`\`\`

- **Style Guide** at \`/\` shows the active theme.
- **Example Components** at \`/example-components/\` uses the same Astro wrappers as the insertion catalog in \`.stacki/components.json\`.

## Edit the theme

Change \`${HEROUI_THEME_FILE}\` directly or use Variables in Stacki or Astro Studio.
Shared settings are in \`:root\`. The two \`data-theme\` rules hold values that differ by mode.
The default values come from \`@heroui/styles@${HEROUI_VERSION}\` and are adapted for project-level editing. See the [HeroUI license](https://github.com/heroui-inc/heroui/blob/v${HEROUI_VERSION}/LICENSE).
Calculated colors and Tailwind's color, radius and shadow utilities read these values. Edit the inputs to change their aliases together.
Use \`data-vibrant-palette="true"\` on a section to use the saturated soft colors.

## Component overrides

Set these properties on the named component or in a scoped wrapper style to change an instance.
The skeleton and tooltip properties also have shared defaults in the theme.

${componentOverrides}

The variables and Tailwind mappings are based on \`@heroui/styles@3.2.8\`, in \`dist/themes/default/variables.css\` and \`dist/themes/shared/theme.css\`.
`;
}
