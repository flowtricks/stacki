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

// The named entities that turn up in hand-written markup. Not the full HTML
// table — that is 2231 names, nearly all of them for characters nobody types —
// but everything an author reaches for, plus the five that are structural.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™', deg: '°',
  hellip: '…', mdash: '—', ndash: '–', minus: '−', shy: '­',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', middot: '·', bull: '•',
  dagger: '†', Dagger: '‡', sect: '§', para: '¶', permil: '‰', prime: '′', Prime: '″',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞', radic: '√', sum: '∑',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â',
  ouml: 'ö', ooslash: 'ø', oslash: 'ø', uuml: 'ü', auml: 'ä', ccedil: 'ç',
  ntilde: 'ñ', szlig: 'ß', aring: 'å', ae: 'æ', oelig: 'œ',
};

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;

/** The characters an entity stands for. Anything unrecognised is left alone —
 *  a name this doesn't know is still valid HTML, and rewriting it as itself is
 *  better than mangling it. */
function decodeEntities(text) {
  return String(text ?? '').replace(ENTITY, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body] ?? NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Characters as text in a file: the three that would otherwise be read as
 * markup, and the spaces that are invisible in a source file. Everything else
 * goes in as itself — `©` is a character the file can hold, and spelling it
 * `&copy;` in a file that says `©` everywhere else would be the editor imposing
 * its own habits.
 */
function encodeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&#160;')
    .replace(/[   ‌‍­]/g, (c) => `&#${c.codePointAt(0)};`);
}

module.exports = { decodeEntities, encodeText };
