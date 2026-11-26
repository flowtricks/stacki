export const styleGuide = `---
import { Button } from "@heroui/react/button";
import Layout from "../layouts/main.astro";

const colorGroups = [
  {
    title: "Surfaces",
    swatches: [
      ["Background", "--background", "--foreground"],
      ["Surface", "--surface", "--surface-foreground"],
      ["Secondary surface", "--surface-secondary", "--surface-secondary-foreground"],
      ["Tertiary surface", "--surface-tertiary", "--surface-tertiary-foreground"],
      ["Overlay", "--overlay", "--overlay-foreground"],
      ["Field", "--field-background", "--field-foreground"],
    ],
  },
  {
    title: "Actions and status",
    swatches: [
      ["Accent", "--accent", "--accent-foreground"],
      ["Default", "--default", "--default-foreground"],
      ["Success", "--success", "--success-foreground"],
      ["Warning", "--warning", "--warning-foreground"],
      ["Danger", "--danger", "--danger-foreground"],
      ["Segment", "--segment", "--segment-foreground"],
    ],
  },
] as const;

const spacing = [1, 2, 4, 6, 8, 12] as const;
const radii = [
  ["Small", 0.5],
  ["Base", 1],
  ["Field", 1.5],
  ["Large", 2],
  ["Extra large", 3],
] as const;
---

<Layout title="Style Guide">
  <div class="mx-auto w-full max-w-6xl px-4 py-10 sm:px-8 sm:py-16">
    <header class="mb-10 border-b border-border pb-8 sm:mb-14">
      <h1 class="text-4xl font-semibold tracking-tight sm:text-5xl">Style Guide</h1>
      <p class="mt-3 max-w-2xl text-muted">Preview the colors, typography, and component states defined by the project theme.</p>
      <nav aria-label="Style guide sections" class="mt-5">
        <ul class="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
          <li><a class="underline underline-offset-4" href="#colors">Colors</a></li>
          <li><a class="underline underline-offset-4" href="#typography">Typography</a></li>
          <li><a class="underline underline-offset-4" href="#spacing">Spacing and radii</a></li>
          <li><a class="underline underline-offset-4" href="#states">Component states</a></li>
        </ul>
      </nav>
    </header>

    <section aria-labelledby="colors" class="mb-12">
      <h2 id="colors" class="text-2xl font-semibold">Colors</h2>
      {colorGroups.map(({ title, swatches }) => (
        <div class="mt-6">
          <h3 class="mb-3 text-sm font-medium text-muted">{title}</h3>
          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {swatches.map(([label, background, foreground]) => (
              <li class="min-w-0 rounded-xl border border-border bg-surface p-2">
                <div class="flex h-15 items-center rounded-lg px-2 text-sm font-semibold" style={{ background: "var(" + background + ")", color: "var(" + foreground + ")" }}>Aa</div>
                <p class="mt-2 px-1 text-sm font-medium">{label}</p>
                <code class="block p-1 text-xs wrap-anywhere text-muted">{background}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>

    <section aria-labelledby="typography" class="mb-12">
      <h2 id="typography" class="mb-4 text-2xl font-semibold">Typography</h2>
      <div class="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
        <div class="bg-surface p-5">
          <code class="text-xs text-muted">--font-sans</code>
          <p class="mt-3 text-3xl leading-tight font-semibold tracking-tight">Keep the heading short.</p>
          <p class="mt-2 text-base text-surface-foreground">Body copy uses the same font at a smaller size.</p>
        </div>
        <div class="bg-surface p-5">
          <code class="text-xs text-muted">--font-mono</code>
          <p class="mt-3 font-mono text-xl">0123456789</p>
          <p class="mt-2 font-mono text-sm">Aa Bb Cc Dd Ee Ff</p>
        </div>
      </div>
    </section>

    <section aria-labelledby="spacing" class="mb-12">
      <h2 id="spacing" class="mb-4 text-2xl font-semibold">Spacing and radii</h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="min-w-0 rounded-2xl border border-border bg-surface p-5">
          <h3 class="mb-4 font-medium">Spacing scale</h3>
          <dl class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
            {spacing.map((step) => (
              <Fragment>
                <dt><code>{step} × --spacing</code></dt>
                <dd><div class="h-2 max-w-full rounded-full bg-accent" style={{ width: "calc(var(--spacing) * " + step + ")" }}></div></dd>
              </Fragment>
            ))}
          </dl>
        </div>
        <div class="min-w-0 rounded-2xl border border-border bg-surface p-5">
          <h3 class="mb-4 font-medium">Corner radii</h3>
          <ul class="flex flex-wrap gap-4 text-sm">
            {radii.map(([label, multiplier]) => (
              <li>
                <div class="mb-2 h-12 w-14 border border-border bg-surface-secondary" style={{ borderRadius: label === "Field" ? "var(--field-radius)" : "calc(var(--radius) * " + multiplier + ")" }}></div>
                {label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>

    <section aria-labelledby="states">
      <h2 id="states" class="mb-4 text-2xl font-semibold">Component states</h2>
      <div class="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-5">
        <Button client:load variant="primary">Primary</Button>
        <span class="inline-flex items-center rounded-field bg-accent-hover px-4 py-2 text-sm font-medium text-accent-foreground">Hover color</span>
        <Button client:load variant="secondary">Secondary</Button>
        <Button client:load variant="danger">Danger</Button>
        <Button client:load isDisabled>Disabled</Button>
      </div>
    </section>
  </div>
</Layout>
`;
