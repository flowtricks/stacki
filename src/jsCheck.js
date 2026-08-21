import { parser } from '@lezer/javascript';

// Whether a statement can be written back without breaking the site.
//
// The frontmatter editor used to splice what you typed into the file on every
// keystroke, so the half-finished shape of a statement — `const x = ` on its
// way to `const x = 1` — was compiled, failed, and replaced the preview with a
// build error you then had to wait out. Two changes stop that: the write waits
// until you leave the field, and a statement that would not parse is not
// written at all.
//
// Lezer rather than `new Function`: it is already in the bundle (CodeMirror
// highlights with it), it doesn't need eval, and it parses TYPESCRIPT — Astro
// frontmatter is TS, so `const media: string = ''` is correct there and would
// be rejected out of hand by a JavaScript-only check.
const ts = parser.configure({ dialect: 'ts' });

// Lezer recovers rather than throwing: a broken statement parses to a tree with
// error nodes in it, and the first one is where the trouble starts.
function firstError(code) {
  const tree = ts.parse(code);
  let at = -1;
  tree.iterate({
    enter: (node) => {
      if (at >= 0) return false;
      if (node.type.isError) {
        at = node.from;
        return false;
      }
      return true;
    },
  });
  return at;
}

/** Where `pos` falls, for a message that can be acted on. */
function lineOf(code, pos) {
  return code.slice(0, pos).split('\n').length;
}

/** The token that goes wrong, so the message names something visible. */
function tokenAt(code, pos) {
  const rest = code.slice(pos);
  const m = rest.match(/^\s*([A-Za-z_$][\w$]*|[^\s\w$])/);
  return m ? m[1] : '';
}

/**
 * `{ ok: true }`, or `{ ok: false, message }` naming what to fix.
 *
 * Empty is ok: clearing the field is a thing to be allowed to do, and the
 * caller decides what an empty statement means.
 */
export function checkStatement(code) {
  const src = String(code ?? '');
  if (!src.trim()) return { ok: true };
  const at = firstError(src);
  if (at < 0) return { ok: true };
  const token = tokenAt(src, at);
  const line = lineOf(src, at);
  const where = src.split('\n').length > 1 ? ` on line ${line}` : '';
  // Past the end: the statement stops in the middle of itself, which reads
  // very differently from a stray character and is the commoner of the two
  // while typing.
  if (at >= src.trimEnd().length) return { ok: false, message: 'This looks unfinished — the statement stops early.' };
  return {
    ok: false,
    message: token ? `Unexpected “${token}”${where}.` : `There's a mistake${where}.`,
  };
}
