// Which of the code editor's grammars a file opens with, by its name. Only grammars the app already ships are used
// (CodeEditor.tsx, codeEditorLanguage): Astro and HTML, CSS, Markdown, TOML and JavaScript/TypeScript (JSON reads as
// JavaScript). Anything else opens as plain text rather than coloured by a grammar that misreads it.
const BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: 'astro',
  htm: 'html',
  html: 'html',
  svg: 'html',
  vue: 'html',
  xml: 'html',
  svelte: 'html',
  css: 'css',
  less: 'css',
  sass: 'css',
  scss: 'css',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  toml: 'toml',
  cjs: 'javascript',
  cts: 'javascript',
  js: 'javascript',
  json: 'javascript',
  json5: 'javascript',
  jsonc: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  mts: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
};

export function editorLanguageFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return Object.hasOwn(BY_EXTENSION, extension) ? (BY_EXTENSION[extension] ?? 'plaintext') : 'plaintext';
}
