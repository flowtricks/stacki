// The Content Security Policy of Stacki's main window, written into the built index.html (vite.config.mjs).
//
// The window holds window.avb, which reads and writes the person's files, so a script that was not shipped with
// Stacki must never run in it. The policy says exactly that: scripts come from the app's own files, plus the inline
// scripts of index.html by their SHA-256; no plugins; no <base> that would move where relative URLs resolve.
// 'wasm-unsafe-eval' lets the page (and the dictation worker, which inherits this policy) compile WebAssembly:
// the ONNX Runtime that runs Whisper on this computer is WebAssembly (docs/voice-engine.md). It permits
// compiling wasm modules only, never JavaScript eval, and the modules still come from the app's own files.
//
// It restricts scripts only, on purpose. Styles, images, fonts and frames stay open: the Insert snapshots are srcdoc
// frames, which inherit this policy, and draw the person's own site with its stylesheets, fonts and remote images.
// Every other frame (the canvas, component previews, Apps) is a document of its own and keeps its own policy.
//
// Only the build adds it. In `npm run dev` Vite serves its own inline scripts and opens a socket for hot reload, which
// a policy written for the built files would refuse.

import { createHash } from 'node:crypto';

/** Inline scripts index.html may hold: a handful is plenty, and the bound keeps a malformed page from being walked forever. */
const INLINE_SCRIPTS_MAX = 16;

/** Where the policy goes: right after the charset, so it governs every script that follows. */
const CHARSET_META = '<meta charset="UTF-8" />';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

/** The policy for `html`: the fixed directives, with one SHA-256 source per inline script the page holds. */
export function rendererContentSecurityPolicy(html: string): string {
  const hashes = inlineScriptHashes(html);
  const policy = [`script-src 'self' 'wasm-unsafe-eval'${hashes.map((hash) => ` '${hash}'`).join('')}`, "object-src 'none'", "base-uri 'self'"].join('; ');
  if (!policy.startsWith("script-src 'self'")) {
    throw new Error('rendererContentSecurityPolicy: scripts come from the app first');
  }
  return policy;
}

/** `html` with the policy as a <meta> right after its charset. Throws when the page cannot take it safely. */
export function withContentSecurityPolicy(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error('withContentSecurityPolicy: the page already has a policy');
  }
  const at = html.indexOf(CHARSET_META);
  if (at < 0) {
    throw new Error(`withContentSecurityPolicy: no ${CHARSET_META} to place the policy after`);
  }
  if (html.indexOf(CHARSET_META, at + 1) >= 0) {
    throw new Error(`withContentSecurityPolicy: more than one ${CHARSET_META}`);
  }
  const firstScript = html.indexOf('<script');
  if (firstScript >= 0 && firstScript < at) {
    throw new Error('withContentSecurityPolicy: a script comes before the charset, outside the policy');
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${rendererContentSecurityPolicy(html)}" />`;
  const end = at + CHARSET_META.length;
  return `${html.slice(0, end)}\n    ${meta}${html.slice(end)}`;
}

/** The CSP source text of each inline script, `sha256-<base64>`, in page order: the hash of the exact text between its tags. */
export function inlineScriptHashes(html: string): readonly string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    if (hashes.length >= INLINE_SCRIPTS_MAX) {
      throw new Error(`inlineScriptHashes: more than ${INLINE_SCRIPTS_MAX} inline scripts`);
    }
    const body = match[1] ?? '';
    hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`);
  }
  return hashes;
}
