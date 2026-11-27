// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what a copy of the document alone does not
// carry, or carries wrong: how animated elements looked on screen (designSettle.ts), the room a script's pin made,
// stylesheet rules written through the CSSOM, constructed stylesheets, and open shadow roots. All of it is written
// on the copy; the live page and the project are not touched.
import { standingStyles } from './designSettleDiff';
import { PIN_HOLDER, type DesignSettled } from './designSettle';

/** Bounds the walks here. */
const SHEETS_MAX = 2_000;
const RULES_MAX = 20_000;
const SHADOW_HOSTS_MAX = 500;
const PINS_MAX = 200;

/** Writes on each copy how its element looked on screen. `sources` and `targets` list the same elements. */
export function applySettled(sources: readonly Element[], targets: readonly Element[], settled: DesignSettled): void {
  sources.forEach((source, index) => {
    const copy = targets[index];
    if (!(copy instanceof HTMLElement || copy instanceof SVGElement) || !(source instanceof HTMLElement || source instanceof SVGElement)) {
      return;
    }
    const override = settled.overrides.get(source);
    if (override !== undefined) {
      // Read at rest, a value that differs now was changed since, by an edit or the page: that one stands.
      const atTop = window.scrollY === 0;
      const styles = atTop
        ? standingStyles(override, (property) => {
            const value = source.style.getPropertyValue(property);
            return value === '' ? undefined : value;
          })
        : override.styles;
      for (const change of styles) {
        if (change.seen === undefined) {
          copy.style.removeProperty(change.property);
        } else {
          copy.style.setProperty(change.property, change.seen.value, change.seen.priority);
        }
      }
      copy.classList.add(...override.classesAdded);
      copy.classList.remove(...override.classesRemoved);
    }
    const motion = settled.motion.get(source);
    if (motion !== undefined) {
      if (settled.scrollDriven.has(source)) {
        copy.style.setProperty('animation', 'none', 'important');
      }
      for (const [property, value] of motion) {
        copy.style.setProperty(property, value, 'important');
      }
    }
  });
}

/**
 * A pinned sequence is shown as it starts, once: the room made for scrolling through it goes, and an element the
 * pin holds on screen goes back into the page's flow.
 */
export function collapsePins(copy: Element): void {
  for (const holder of Array.from(copy.querySelectorAll<HTMLElement>(PIN_HOLDER)).slice(0, PINS_MAX)) {
    for (const property of ['padding', 'padding-top', 'padding-bottom', 'height', 'min-height', 'max-height']) {
      holder.style.removeProperty(property);
    }
    holder.style.setProperty('height', 'auto', 'important');
    holder.style.setProperty('padding-bottom', '0', 'important');
    const pinned = holder.firstElementChild;
    if (pinned instanceof HTMLElement && pinned.style.position === 'fixed') {
      pinned.style.setProperty('position', 'relative', 'important');
      for (const property of ['top', 'left', 'translate', 'transform']) {
        pinned.style.removeProperty(property);
      }
    }
  }
}

function textOfRules(sheet: CSSStyleSheet): string | undefined {
  try {
    return Array.from(sheet.cssRules)
      .slice(0, RULES_MAX)
      .map((rule) => rule.cssText)
      .join('\n');
  } catch {
    return undefined;
  }
}

/** Whether a <style> holds rules its text does not: written with insertRule, as CSS-in-JS libraries do. */
function holdsUnwrittenRules(style: HTMLStyleElement): boolean {
  const sheet = style.sheet;
  if (sheet === null || sheet.cssRules.length === 0) {
    return false;
  }
  const written = style.textContent ?? '';
  if (written.trim() === '') {
    return true;
  }
  // A constructed sheet takes no @import, so those are counted out of both.
  const parsed = new CSSStyleSheet();
  parsed.replaceSync(written);
  const imports = Array.from(sheet.cssRules).filter((rule) => rule instanceof CSSImportRule).length;
  return sheet.cssRules.length - imports > parsed.cssRules.length;
}

/** Gives each such <style> of the copy its rules as text. `source` and `target` hold the same <style> elements. */
export function writeStyleRules(source: ParentNode, target: ParentNode): void {
  const sources = Array.from(source.querySelectorAll('style'));
  const targets = Array.from(target.querySelectorAll('style'));
  if (sources.length !== targets.length) {
    return;
  }
  sources.slice(0, SHEETS_MAX).forEach((style, index) => {
    const copy = targets[index];
    if (copy !== undefined && style.sheet !== null && holdsUnwrittenRules(style)) {
      const text = textOfRules(style.sheet);
      if (text !== undefined) {
        copy.textContent = text;
      }
    }
  });
}

/** The constructed stylesheets of a document or shadow root, as <style> elements appended to `target`. */
export function writeAdoptedSheets(source: Document | ShadowRoot, target: Node): void {
  for (const sheet of Array.from(source.adoptedStyleSheets ?? []).slice(0, SHEETS_MAX)) {
    const text = sheet.disabled ? undefined : textOfRules(sheet);
    if (text !== undefined) {
      const style = document.createElement('style');
      style.textContent = text;
      target.appendChild(style);
    }
  }
}

interface ShadowPair {
  readonly source: Element;
  readonly copy: Element;
}

function shadowPairs(sources: readonly Element[], targets: readonly Element[]): ShadowPair[] {
  const pairs: ShadowPair[] = [];
  sources.forEach((source, index) => {
    const copy = targets[index];
    if (copy !== undefined && source.shadowRoot !== null) {
      pairs.push({ source, copy });
    }
  });
  return pairs;
}

/**
 * Writes each open shadow root as a declarative one, which a frame's parser attaches again with no script. Closed
 * roots cannot be read, and their hosts stay as their light content shows. Run after the copy's own templates are
 * taken out.
 */
export function writeShadowRoots(sources: readonly Element[], targets: readonly Element[], leftOut: string): void {
  const queue = shadowPairs(sources, targets);
  for (let at = 0; at < queue.length && at < SHADOW_HOSTS_MAX; at += 1) {
    const pair = queue[at];
    const root = pair?.source.shadowRoot;
    if (pair === undefined || root === null || root === undefined) {
      continue;
    }
    const holder = document.createElement('template');
    holder.setAttribute('shadowrootmode', 'open');
    // Cloned into the template's own inert document, where nothing loads or upgrades.
    for (const child of Array.from(root.childNodes)) {
      holder.content.appendChild(holder.content.ownerDocument.importNode(child, true));
    }
    const inner = Array.from(root.querySelectorAll('*'));
    const copies = Array.from(holder.content.querySelectorAll('*'));
    if (inner.length === copies.length) {
      queue.push(...shadowPairs(inner, copies));
    }
    writeStyleRules(root, holder.content);
    for (const piece of Array.from(holder.content.querySelectorAll(leftOut))) {
      piece.remove();
    }
    writeAdoptedSheets(root, holder.content);
    pair.copy.insertBefore(holder, pair.copy.firstChild);
  }
}
