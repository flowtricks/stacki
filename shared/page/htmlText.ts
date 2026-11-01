// Text as the page shows it, and as the file writes it.
//
// `<p>&copy;&#160;{SITE_NAME}</p>` renders as "© Remarkable". The navigator drew
// the row as `&copy;`, the Content field offered `&#160;` to edit, and both were
// showing the source's spelling of a character rather than the character. An
// editor over a rendered page has to say what the page says.
//
// So a text node holds the characters, and the file keeps its own spelling: an
// untouched node is written back exactly as it was found (the writer has the
// original to hand), and one that has been edited is written as its characters,
// with the three that would otherwise be markup put back into entities.
//
// It lives in shared/ because both processes need the same rule: the parser
// reads a text node's value with it, and the Content field has to emit values
// the parser will hand back unchanged. Every save echoes through the parser,
// and an echo that differs from what the field emitted rewrites the field
// mid-keystroke, sending the caret to the start of the line.
import { assert } from '../core/assert';

// The named entities that turn up in hand-written markup. Not the full HTML
// table — that is 2231 names, nearly all of them for characters nobody types —
// but everything an author reaches for, plus the five that are structural.
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  shy: '­',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  middot: '·',
  bull: '•',
  dagger: '†',
  Dagger: '‡',
  sect: '§',
  para: '¶',
  permil: '‰',
  prime: '′',
  Prime: '″',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  ne: '≠',
  le: '≤',
  ge: '≥',
  asymp: '≈',
  infin: '∞',
  radic: '√',
  sum: '∑',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  ouml: 'ö',
  ooslash: 'ø',
  oslash: 'ø',
  uuml: 'ü',
  auml: 'ä',
  ccedil: 'ç',
  ntilde: 'ñ',
  szlig: 'ß',
  aring: 'å',
  ae: 'æ',
  oelig: 'œ',
};

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

/** The characters an entity stands for. Anything unrecognised is left alone —
 *  a name this doesn't know is still valid HTML, and rewriting it as itself is
 *  better than mangling it. */
function decodeEntities(text: unknown): string {
  return String(text ?? '').replace(ENTITY, (whole: string, body: string): string => {
    if (body.charAt(0) === '#') {
      const second = body.charAt(1);
      const code = second === 'x' || second === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) {
        return whole;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    // Own properties only: NAMED['constructor'] would otherwise resolve the
    // inherited Object.prototype member and hand back a function.
    if (Object.hasOwn(NAMED, body)) {
      return NAMED[body] ?? whole;
    }
    const lower = body.toLowerCase();
    if (Object.hasOwn(NAMED, lower)) {
      return NAMED[lower] ?? whole;
    }
    return whole;
  });
}

/**
 * Characters as text in a file: markup delimiters, Astro expression braces,
 * and the spaces that are invisible in a source file. Everything else
 * goes in as itself — `©` is a character the file can hold, and spelling it
 * `&copy;` in a file that says `©` everywhere else would be the editor imposing
 * its own habits.
 */
function encodeText(text: unknown): string {
  return String(text ?? '').replace(/[&<>{}    ‌‍­]/g, (character: string): string => {
    if (character === '&') {
      return '&amp;';
    }
    if (character === '<') {
      return '&lt;';
    }
    if (character === '>') {
      return '&gt;';
    }
    const code = character.codePointAt(0);
    if (code === undefined) {
      return character;
    }
    return `&#${code};`;
  });
}

// Same result as replacing every `\s+` run with one space, but a run that is
// already one plain space is left unmatched: prose has one at every word gap,
// and rewriting each of them rebuilt long paragraphs thousands of times over.
function collapseWhitespace(text: string): string {
  return text.replace(/\s{2,}|[^\S ]/g, ' ').trim();
}

// The words, with every run of whitespace inside them squeezed to one space,
// and a single space kept at either end where the source had any — a
// newline-and-indent boundary renders as one space, and "people
// <strong>Acme</strong>" would otherwise lose the gap. The source's own
// spelling is kept: entities are still entities here.
function collapseText(raw: string): string {
  return (/^\s/.test(raw) ? ' ' : '') + collapseWhitespace(raw) + (/\s$/.test(raw) ? ' ' : '');
}

// What a text node HOLDS: the characters, not the file's spelling of them.
// `&copy;&#160;` is one character and a space, and a panel over a rendered page
// has to say what the page says. Decoded after the whitespace above, not
// before: `&#160;` is a space to `\s`, and collapsing it away would delete the
// very character it was written to insist on.
//
// The parser reads every text node with it; the serializer recomputes it to
// tell an edited node from an untouched one.
function textValue(raw: string): string {
  const collapsed = collapseText(raw);
  // Every entity starts with `&`; without one there is nothing to decode, and
  // the check is far cheaper than a regex pass over a long paragraph.
  return collapsed.includes('&') ? decodeEntities(collapsed) : collapsed;
}

/**
 * The value a text node holds once an edited value has been written to the
 * file and read back: `encodeText` is how the serializer writes an edited
 * node, `textValue` how the parser reads it. Emitting this instead of the raw
 * characters makes the save echo identical to what was emitted, so a space
 * typed after a word survives, and three typed spaces converge on one at once
 * instead of mismatching once. The characters `encodeText` writes as entities
 * (U+00A0 among them) are kept: the parser collapses before it decodes.
 *
 * A value that is only whitespace is not a text node to the parser at all —
 * it drops the run between tags — so no value round-trips; one space is what
 * a browser renders for it, and is kept rather than doubled by the boundary
 * rule.
 */
function textValueCanonical(value: string): string {
  // Blank as the file will hold it: a lone U+00A0 is written `&#160;`, which
  // is words to the parser, not whitespace.
  const written = encodeText(value);
  if (written.trim().length === 0) {
    return value.length === 0 ? '' : ' ';
  }
  const canonical = textValue(written);
  assert(canonical.length <= value.length, 'Canonical text never grows');
  assert(textValue(encodeText(canonical)) === canonical, 'Canonical text is a fixed point of write-then-read');
  return canonical;
}

export { collapseText, decodeEntities, encodeText, textValue, textValueCanonical };
