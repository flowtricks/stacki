// The initial rendering, embedded in the page for morph.js. The dev middleware and
// the baked build share this, so both pages hand morph.js the same thing.
export function renderBaselineScript(html: string): string {
  // Escaping '<' prevents page content from ending this inert JSON script.
  const encoded = JSON.stringify(html).replaceAll('<', '\\u003c');
  return `<script id="studio-render-baseline" type="application/json">${encoded}</script>`;
}
