// The Style panel's half of live rule previews (shared/properties/liveRules.ts):
// each edit to a rule is also sent to the canvas, which shows it at once, and
// each save's outcome follows, so the canvas keeps the preview until the page
// holds the value (the save landed) or puts the page's own value back now (it
// did not). Desktop and Studio both register their canvas frame with
// canvasQuery.ts, so one path serves both, as it does for live variables.

import { assert } from '../../../../shared/core/assert';
import {
  HOVER_STYLE_LIMITS,
  HOVER_STYLE_MESSAGE,
  LIVE_RULE_LIMITS,
  LIVE_RULE_MESSAGE,
  liveRuleKey,
  parseLiveRuleTarget,
  type HoverDeclaration,
  type HoverStyleMessage,
  type LiveRuleEdit,
  type LiveRuleMessage,
  type LiveRuleTarget,
} from '../../../../shared/properties/liveRules';
import { tellCanvas } from '../../../editor/canvasQuery';
import type { ParsedRule } from './styleTypes';
import type { EmbedSource } from './webflow';

/** One preview on its way: what was sent and which send it was. */
export interface LiveRulePreview {
  readonly target: LiveRuleTarget;
  readonly token: number;
}

/**
 * The canvas's previews, as the panel drives them. `show` sends an edit; `landed`
 * and `failed` report its save. Only the newest edit of a declaration may settle it:
 * a scrub's earlier saves land while a later value is on screen, and releasing on
 * those would let the page's older value through.
 */
export function createLiveRules(post: (message: LiveRuleMessage) => void) {
  const newest = new Map<string, number>(); // Key → token of the newest edit sent.
  let tokenNext = 1;

  const remember = (key: string, token: number): void => {
    newest.delete(key); // Re-inserted last, so the map stays in edit order.
    if (newest.size >= LIVE_RULE_LIMITS.entriesMax) {
      const oldest = newest.keys().next().value;
      assert(oldest !== undefined, 'Live rules: a full map has an oldest entry');
      newest.delete(oldest); // The frame evicts its oldest at the same bound.
    }
    newest.set(key, token);
    assert(newest.size <= LIVE_RULE_LIMITS.entriesMax, 'Live rules: tracked edits stay bounded');
  };

  // The edit `preview` sent is still the newest of its declaration: it alone may settle it.
  const takeNewest = (preview: LiveRulePreview): boolean => {
    const key = liveRuleKey(preview.target);
    if (newest.get(key) !== preview.token) {
      return false;
    }
    newest.delete(key);
    return true;
  };

  return {
    show(target: LiveRuleTarget, edit: LiveRuleEdit): LiveRulePreview {
      assert(Number.isSafeInteger(tokenNext), 'Live rules: token stays a safe integer');
      const token = tokenNext;
      tokenNext += 1;
      remember(liveRuleKey(target), token);
      post({ type: LIVE_RULE_MESSAGE, op: 'set', rule: target, edit });
      return { target, token };
    },
    /** The save holding `edit` landed: the canvas keeps the preview until the page holds it. */
    landed(preview: LiveRulePreview, edit: LiveRuleEdit): void {
      if (takeNewest(preview)) {
        post({ type: LIVE_RULE_MESSAGE, op: 'drop', rule: preview.target, until: edit });
      }
    },
    /** The save was refused, failed or held: the canvas shows the page's own value again. */
    failed(preview: LiveRulePreview): void {
      if (takeNewest(preview)) {
        post({ type: LIVE_RULE_MESSAGE, op: 'drop', rule: preview.target });
      }
    },
  };
}

/** The panel's previews, sent to whichever canvas frame is registered. */
export const liveRules = createLiveRules((message) => {
  tellCanvas(message);
});

/**
 * The declaration a rule edit changes, as the canvas finds it; undefined when the canvas
 * could not (a rule nested in another, a `<style>` with no file, a path outside the project).
 * The save shows those at the old speed.
 */
export function liveRuleTargetOf(rule: ParsedRule, source: EmbedSource, property: string, projectPath: string | undefined): LiveRuleTarget | undefined {
  if (rule.written !== undefined && rule.written.parents.length > 0) {
    return undefined; // Nested source resolves to a selector no compiled rule carries.
  }
  const path = sourcePathOf(source);
  if (path === undefined) {
    return undefined;
  }
  const relative = projectRelative(path, projectPath);
  if (relative === undefined) {
    return undefined;
  }
  // Parsed here as the frame will parse it, so the panel never sends what the frame refuses.
  return parseLiveRuleTarget({ source: relative, context: rule.atContext, selector: rule.selectorText, property });
}

function sourcePathOf(source: EmbedSource): string | undefined {
  const origin = source.origin;
  switch (origin.kind) {
    case 'file':
    case 'astro':
      return origin.path;
    case 'node':
      return origin.filePath;
    default: {
      const exhaustive: never = origin;
      return exhaustive;
    }
  }
}

/** `path` relative to the project, with `/` separators; undefined when it climbs out of it. */
export function projectRelative(path: string, projectPath: string | undefined): string | undefined {
  let relative = path.replace(/\\/g, '/');
  if (projectPath !== undefined) {
    const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (root.length > 0) {
      if (relative.startsWith(`${root}/`)) {
        relative = relative.slice(root.length + 1);
      }
    }
  }
  relative = relative.replace(/^(?:\.\/|\/)+/, '');
  if (relative.length === 0) {
    return undefined;
  }
  if (relative.split('/').includes('..')) {
    return undefined;
  }
  return relative;
}

// ───────────────────────────── Hover previews ─────────────────────────────

/**
 * The panel's half of the hover preview (shared/properties/liveRules.ts `avb:hover-style`): what is
 * shown on the selected element while a picker row or a dropdown option is hovered, and never
 * written. One preview is up at a time. `clear` takes it away when the hover ends without a pick;
 * `settle` hands it to the frame when a write of the previewed value starts (a pick), so the canvas
 * keeps it until the page holds that value instead of flashing the old one; a write of anything
 * else clears it. Both only act for the properties the preview showed, so a field's late restore
 * never takes away another field's preview.
 */
export function createHoverStyle(post: (message: HoverStyleMessage) => void) {
  let shown: readonly HoverDeclaration[] | undefined = undefined;
  const owns = (properties: readonly string[]): boolean =>
    shown !== undefined && properties.some((property) => shown?.some((declaration) => declaration.property === property) === true);
  const clear = (properties: readonly string[]): void => {
    if (!owns(properties)) {
      return;
    }
    shown = undefined;
    post({ type: HOVER_STYLE_MESSAGE, op: 'clear' });
  };
  return {
    show(path: string, declarations: readonly HoverDeclaration[]): void {
      assert(declarations.length > 0, 'Hover style: a preview shows something');
      assert(declarations.length <= HOVER_STYLE_LIMITS.declarationsMax, 'Hover style: declarations stay bounded');
      shown = declarations;
      post({ type: HOVER_STYLE_MESSAGE, op: 'show', path, declarations });
    },
    clear,
    /** A write of `value` to `property` starts: a preview of that very value settles, any other goes now. */
    settle(property: string, value: string): void {
      if (!owns([property])) {
        return;
      }
      const previewed = shown?.find((declaration) => declaration.property === property);
      if (previewed === undefined || previewed.value !== value) {
        clear([property]);
        return;
      }
      shown = undefined;
      post({ type: HOVER_STYLE_MESSAGE, op: 'settle' });
    },
    /** For tests and the panel's unmount: the properties the preview shows now. */
    showing(): readonly string[] {
      return shown === undefined ? [] : shown.map((declaration) => declaration.property);
    },
  };
}

/** The panel's hover preview, sent to whichever canvas frame is registered. */
export const hoverStyle = createHoverStyle((message) => {
  tellCanvas(message);
});
