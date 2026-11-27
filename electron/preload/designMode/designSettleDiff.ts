// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what an element needs on a copy to look as it
// did while it was on screen: the declarations and classes it had then that it no longer has at rest. Only those:
// everything else on the element stays as the page has it when it is copied, so an edit made since is never undone.
// Pure, so a test runs it without a browser.

export interface DesignAppearance {
  readonly style: string | undefined;
  readonly classes: readonly string[];
}

export interface DesignDeclaration {
  readonly value: string;
  readonly priority: string;
}

/** A style attribute's declarations by property, as the browser's parser reads them. */
export type DesignStyleParser = (text: string) => ReadonlyMap<string, DesignDeclaration>;

export interface DesignStyleChange {
  readonly property: string;
  /** The declaration while on screen; undefined where there was none. */
  readonly seen: DesignDeclaration | undefined;
  /** The value at rest, when the walk read it; undefined where there was none. */
  readonly rest: string | undefined;
}

export interface DesignOverride {
  readonly styles: readonly DesignStyleChange[];
  readonly classesAdded: readonly string[];
  readonly classesRemoved: readonly string[];
}

/** Declarations and classes one element's difference may hold: past this the element is not one that animates. */
const CHANGES_MAX = 100;

export function differenceOf(seen: DesignAppearance, rest: DesignAppearance, parse: DesignStyleParser): DesignOverride | undefined {
  const styles: DesignStyleChange[] = [];
  if (seen.style !== rest.style) {
    const then = parse(seen.style ?? '');
    const now = parse(rest.style ?? '');
    for (const property of new Set([...then.keys(), ...now.keys()])) {
      const before = then.get(property);
      const after = now.get(property);
      if (before?.value !== after?.value || before?.priority !== after?.priority) {
        styles.push({ property, seen: before, rest: after?.value });
      }
    }
  }
  const classesAdded = seen.classes.filter((name) => !rest.classes.includes(name));
  const classesRemoved = rest.classes.filter((name) => !seen.classes.includes(name));
  const changes = styles.length + classesAdded.length + classesRemoved.length;
  return changes === 0 || changes > CHANGES_MAX ? undefined : { styles, classesAdded, classesRemoved };
}

/** What changes of `override` still apply to a page at rest: a value the page has changed since is the page's. */
export function standingStyles(override: DesignOverride, valueNow: (property: string) => string | undefined): readonly DesignStyleChange[] {
  return override.styles.filter((change) => valueNow(change.property) === change.rest);
}
