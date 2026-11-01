// What a component offers beyond its props: its slots, its root tag, the
// layout it extends, and whether its default slot is inline.

import type { RenderTag } from './astroParserTypes';
import { VOID_ELEMENTS, required } from './astroAttrs';
import { skipStringOrComment } from './astroScan';

// The slot a use of `Astro.slots` is about, and the const it was read into.
//
// A component does not have to render `<slot />` to take slot content. It can
// read the slot itself — which is the only way to ask whether the slot
// rendered anything, and so the usual shape for a component that draws nothing
// when it is empty:
//
//   const content = await Astro.slots.render('default');
//   const column2 = await slotContent(Astro.slots, 'column2');
//
// Read from the call around it: `.render(x)` / `.has(x)` name their slot
// outright, and where `Astro.slots` is handed to a helper the string beside it
// is the name. No string means the default slot — which is also the answer for
// `render(someVariable)`, where nothing in the file says which slot it is.
//
// Scans forward from the reference to the end of the call it sits in, so a
// second call further down the file can't lend it a name.
function slotApiUses(source: string): { slot: string; varName: string | undefined }[] {
  const text = withoutComments(source);
  const uses = [];
  const re = /Astro\s*\.\s*slots\b(\s*\.\s*(?:render|has)\s*\()?/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    // Either we just consumed the opening paren of `.render(` / `.has(`, or
    // the reference is an argument in a call whose paren is behind us. Both
    // are one level in, and both end at the ')' that closes it.
    let depth = 1;
    let name = undefined;
    for (let i = match.index + match[0].length; i < text.length; i++) {
      const character = text.charAt(i);
      if (character === '"' || character === "'" || character === '`') {
        const close = text.indexOf(character, i + 1);
        const quoted = text.slice(i + 1, close === -1 ? text.length : close);
        if (name === undefined && /^[\w-]*$/.test(quoted)) {
          name = quoted;
        }
        if (close === -1) {
          break;
        }
        i = close;
        continue;
      }
      if (character === '(' || character === '[' || character === '{') {
        depth++;
      } else if (character === ')' || character === ']' || character === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      } else if (depth === 1 && character === ';') {
        break;
      }
    }
    // `const content = await slotContent(...)` — the name that now holds it,
    // which is what the template puts back with `set:html`.
    const decl = text.slice(0, match.index).match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[^;\n]*$/);
    uses.push({
      slot: name || 'default',
      varName: decl ? required(decl[1], 'Slot variable capture') : undefined,
    });
  }
  return uses;
}

// The source with what it says ABOUT itself blanked out, character for
// character so every index still points where it did. A frontmatter comment
// explaining how the component consumes its slots reads exactly like code
// that consumes them — three files in two projects grew a slot called "0"
// from a sentence about `Astro.slots.render()`.
//
// Only frontmatter takes `//` and `/* */`: in the template body a `//` is far
// more likely to be the middle of a URL than the start of a comment. Html
// comments are blanked wherever they are.
function withoutComments(source: string): string {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const chars = [...source];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') {
        chars[i] = ' ';
      }
    }
  };
  const end = fm ? fm[0].length : 0;
  for (let i = 0; i < end; i++) {
    const skipped = skipStringOrComment(source, i);
    if (skipped === i) {
      continue;
    }
    if (source[i] === '/') {
      blank(i, skipped);
    }
    i = skipped - 1;
  }
  for (const comment of source.matchAll(/<!--[\s\S]*?-->/g)) {
    blank(comment.index, comment.index + comment[0].length);
  }
  return chars.join('');
}

// Slot names a component's template exposes: 'default' for <slot>/<slot />,
// plus any <slot name="x">, plus any slot the frontmatter reads through
// `Astro.slots` (see slotApiUses). Default first, then named in appearance
// order.
export function parseSlots(source: string): string[] {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const body = fm ? source.slice(fm[0].length) : source;
  const found = new Set<string>();
  const re = /<slot\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)\/?>/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const nameMatch = required(match[1], 'Slot attributes capture').match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    found.add(nameMatch ? required(nameMatch[1] ?? nameMatch[2], 'Slot name capture') : 'default');
  }
  for (const use of slotApiUses(source)) {
    found.add(use.slot);
  }
  const named = [...found].filter((slot) => slot !== 'default');
  return found.has('default') ? ['default', ...named] : named;
}

// Tags that hold a line of text rather than a place to put blocks. What
// wraps a component's default <slot /> says what the component is for: a
// <slot> inside a <p> or a heading wants words, one inside a <div> wants
// other components.
const TEXT_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'button',
  'caption',
  'cite',
  'code',
  'dd',
  'dt',
  'em',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'label',
  'legend',
  'li',
  'option',
  'p',
  'q',
  'small',
  'span',
  'strong',
  'summary',
  'td',
  'th',
  'title',
]);

// A tag name written as `<Tag>` is a variable — resolve it back to the literal
// it holds. `const Tag = tag;` with `tag = "h2"` in the props destructure is
// the common shape; `const Tag = isLink ? "a" : "button"` names its options
// outright. Returns every tag it could be, or [] when that can't be told.
function dynamicTagLiterals(frontmatter: string, name: string): string[] {
  const alias = destructuredTag(frontmatter, name);
  if (alias) {
    return [alias.tag];
  }
  const decl = frontmatter.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`));
  if (!decl) {
    return [];
  }
  const literals = [...required(decl[1], 'Dynamic tag expression capture').matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)].map((match) =>
    required(match[1], 'Tag literal capture'),
  );
  if (literals.length) {
    return literals;
  }
  const ident = required(decl[1], 'Dynamic tag expression capture')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)$/);
  if (!ident) {
    return [];
  }
  // `const Tag = tag` — the default sits in the destructure or its own const.
  const viaDefault = frontmatter.match(new RegExp(`\\b${ident[1]}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`));
  return viaDefault ? [required(viaDefault[1], 'Dynamic tag default capture')] : [];
}

// Lumos also declares dynamic tags directly in Astro.props: `tag: Tag = "h2"`.
function destructuredTag(frontmatter: string, name: string): { prop: string; tag: string } | undefined {
  const declarations = frontmatter.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*Astro\.props\b/g);
  for (const declaration of declarations) {
    const match = declaration[1]?.match(new RegExp(`(?:^|,)\\s*([A-Za-z_$][\\w$]*)\\s*:\\s*${name}\\s*=\\s*["']([A-Za-z][\\w-]*)["']`));
    if (match?.[1] && match[2]) {
      return { prop: match[1], tag: match[2].toLowerCase() };
    }
  }
  return undefined;
}

// The HTML tag a component renders as, so nesting rules can reach through it:
// a <Paragraph> is a <p>, and a <p> can't go inside an <h1> however the
// component is named. Returns { tag } when it's fixed, { prop, fallback,
// options } when a prop decides it (`<Tag>` from `const Tag = tag`, with
// `tag = "h2"` in the destructure), or undefined when it can't be told.
export function rootTag(source: string): RenderTag | undefined {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  // The first element of the template that isn't a wrapper Astro strips.
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const closing = match[1];
    const name = required(match[2], 'Root tag name capture');
    if (closing) {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'fragment' || lower === 'slot' || lower === 'style' || lower === 'script') {
      continue;
    }
    if (!/^[A-Z]/.test(name)) {
      return { tag: lower };
    }
    // A capitalised name is either another component — whose own tag this
    // file can't know — or a variable holding one.
    const alias = destructuredTag(frontmatter, name);
    if (alias) {
      return alias;
    }
    const decl = frontmatter.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`));
    if (!decl) {
      return undefined;
    }
    const expr = required(decl[1], 'Dynamic tag expression capture').trim();
    // `const Tag = tag` — the prop decides, so report it along with the
    // default, and an instance that sets the prop overrides the default.
    const ident = expr.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident) {
      const prop = required(ident[1], 'Dynamic tag prop capture');
      const dflt = frontmatter.match(new RegExp(`\\b${prop}\\s*=\\s*["'\`]([A-Za-z][\\w-]*)["'\`]`));
      return dflt ? { prop, tag: required(dflt[1], 'Root tag default capture').toLowerCase() } : { prop };
    }
    // `const Tag = isLink ? "a" : "button"` — it's one of these, and which
    // one depends on values only the page knows.
    const lits = [...expr.matchAll(/["'`]([A-Za-z][\w-]*)["'`]/g)].map((x) => required(x[1], 'Root tag literal capture').toLowerCase());
    if (lits.length === 1) {
      return { tag: required(lits[0], 'Root has exactly one literal tag') };
    }
    if (lits.length > 1) {
      return { options: lits };
    }
    return undefined;
  }
  return undefined;
}

// Whether a component's default <slot /> sits somewhere text belongs, so a
// freshly inserted one can arrive with a word in it instead of empty. False
// for a slot that isn't wrapped at all, or wrapped in something structural.
//
// A component that read its slot itself puts it back with `set:html`, and that
// is the same placeholder under another name — `<Fragment set:html={content}/>`
// inside a <Tag> is where the default slot renders. Which const holds it comes
// from slotApiUses.
export function defaultSlotInline(source: string): boolean {
  const fm = source.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/);
  const frontmatter = fm ? fm[0] : '';
  const body = fm ? source.slice(fm[0].length) : source;
  const heldBy = new Set(
    slotApiUses(source)
      .filter((use) => use.slot === 'default' && use.varName)
      .map((use) => use.varName),
  );
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*?)(\/?)>/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const closing = match[1];
    const tag = required(match[2], 'Slot parent tag capture');
    const attrs = required(match[3], 'Slot parent attributes capture');
    const selfClosing = match[4];
    const html = !closing && attrs.match(/\bset:html\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/);
    const isSlot = tag.toLowerCase() === 'slot' && !closing && !/\bname\s*=/.test(attrs);
    // A <Fragment> renders nothing of its own, so what wraps the content is
    // the tag above it. Anything else IS the wrapper.
    const placeholder = isSlot || (html && heldBy.has(required(html[1], 'Slot content variable capture')));
    if (placeholder) {
      const parent = isSlot || tag === 'Fragment' ? stack[stack.length - 1] : tag;
      if (!parent) {
        return false;
      }
      if (TEXT_TAGS.has(parent.toLowerCase())) {
        return true;
      }
      if (!/^[A-Z]/.test(parent)) {
        return false;
      }
      const options = dynamicTagLiterals(frontmatter, parent);
      return options.length > 0 && options.every((tag) => TEXT_TAGS.has(tag.toLowerCase()));
    }
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at !== -1) {
        stack.length = at;
      }
    } else if (!selfClosing && !VOID_ELEMENTS.has(tag.toLowerCase())) {
      stack.push(tag);
    }
  }
  return false;
}

// Extracts the tag from `interface Props extends HTMLAttributes<"button">`
// so the UI can offer that element's built-in attributes (type, disabled, …).
export function parseExtendsTag(source: string): string | undefined {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = fm ? required(fm[1], 'Frontmatter capture') : '';
  const match = frontmatter.match(new RegExp('interface\\s+Props\\s+extends\\s+(?:astroHTML\\.JSX\\' + '.)?HTMLAttributes\\s*<\\s*[\'"](\\w+)[\'"]\\s*>', ''));
  return match ? required(match[1], 'Extended HTML tag capture') : undefined;
}
