const NOT_FOUND = `---
import Layout from "@/layouts/main.astro";

const home = import.meta.env.BASE_URL.replace(/\\/$/, "") + "/";
---

<Layout title="Page not found" description="This page is unavailable. Return to the gallery to explore the design tokens and components.">
  <section class="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 text-center">
    <h1 class="text-3xl font-semibold">Page not found</h1>
    <p class="text-muted-foreground">The page may have moved or the address may be incorrect.</p>
    <a href={home} class="rounded-md bg-primary px-4 py-2 text-primary-foreground">Back to Style Gallery</a>
  </section>
</Layout>
`;

const SITEMAP = `import type { APIRoute } from "astro";

// The sitemap protocol requires absolute URLs. Configure Astro's site option before deploying.
export const GET: APIRoute = ({ site, url }) => {
  const origin = site ?? (import.meta.env.DEV ? url : undefined);
  const base = import.meta.env.BASE_URL.replace(/\\/$/, "");
  const routes = ["/", "/example-components/"];
  const entries = origin === undefined ? [] : routes.map((route) => {
    const address = new URL(base + route, origin).href.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return "<url><loc>" + address + "</loc></url>";
  });
  const xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    entries.join("") + "</urlset>";
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
`;

const ROBOTS = `import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\\/$/, "");
  const sitemap = site === undefined ? "" : "Sitemap: " + new URL(base + "/sitemap.xml", site).href + "\\n";
  return new Response("User-agent: *\\nAllow: /\\n" + sitemap, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
`;

export function shadcnStarterSiteFiles(): Readonly<Record<string, string | Uint8Array>> {
  return {
    'src/pages/404.astro': NOT_FOUND,
    'src/pages/sitemap.xml.ts': SITEMAP,
    'src/pages/robots.txt.ts': ROBOTS,
    'public/gallery-social.png': Buffer.from(SOCIAL_IMAGE_BASE64, 'base64'),
  };
}

// A 1200×630, theme-neutral preview. Embedding it keeps packaged starter generation self-contained.
const SOCIAL_IMAGE_BASE64 =
  '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' +
  'AAAENo/vXBAvKfnKDUAAAAASUVORK5CYII=';
