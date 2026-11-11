// How a lock click changes `.stacki/styles.json`, as pure functions over the
// report and the keep list, so the panel writes each change as one witnessed
// write (and one undo step) and the rules can be tested without a window.
//
// - Unlocking one selector in a locked stylesheet or folder removes that lock
//   and locks every other selector it covered by name, so the only change the
//   user sees is the one selector unlocked.
// - Locking a stylesheet or folder replaces the name locks that only its
//   selectors needed, so the keep list does not fill up with duplicates.
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import { verdictNames, type SelectorEntry, type SelectorReport } from '../../../shared/properties/selectorUsage';
import {
  STYLE_KEEP_LIMITS,
  isLockedFolder,
  keepMatcher,
  stylesheetLock,
  stylesheetLockMatcher,
  type StyleKeepList,
} from '../../../shared/properties/styleKeepList';
import { exactPatterns } from './selectorList';

/** Names and stylesheet paths to add to or drop from the keep list. */
export interface KeepListChange {
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly lock: readonly string[];
  readonly unlock: readonly string[];
}

/** Whether a stylesheet path is covered by one lock entry (a file, or a folder ending in `/`). */
function coveredBy(entry: string, rel: string): boolean {
  return entry === rel || (isLockedFolder(entry) && rel.startsWith(entry));
}

/**
 * Unlock `target`, a locked row in a locked stylesheet: drop the lock that
 * covers it and lock every other selector that lock was keeping by name.
 * Refused, not truncated, when the names would pass the keep list's bound.
 */
export function unlockOneChange(report: SelectorReport, keepList: StyleKeepList, target: SelectorEntry): Result<KeepListChange, string> {
  assert(target.verdict.kind === 'kept', 'unlockOneChange: only a locked row is unlocked');
  const covering = stylesheetLock(keepList, target.rel);
  assert(covering !== undefined, 'unlockOneChange: the row is in a locked stylesheet');
  const targetNames = new Set(verdictNames(target.verdict));
  const remaining = stylesheetLockMatcher({ ...keepList, lockedStylesheets: keepList.lockedStylesheets.filter((entry) => entry !== covering) });
  const kept = keepMatcher(keepList);
  const add = new Set<string>();
  for (const entry of report.entries) {
    if (!coveredBy(covering, entry.rel)) {
      continue;
    }
    // A sheet with a lock of its own stays locked once this one goes.
    if (remaining(entry.rel)) {
      continue;
    }
    if (entry.verdict.kind === 'kept' || entry.verdict.kind === 'checking') {
      for (const name of verdictNames(entry.verdict)) {
        if (!targetNames.has(name) && !kept(name)) {
          add.add(name);
        }
      }
    }
  }
  const size = new Set([...keepList.keep, ...add]).size;
  if (size > STYLE_KEEP_LIMITS.patternsMax) {
    const where = isLockedFolder(covering) ? covering : covering.slice(covering.lastIndexOf('/') + 1);
    return err(
      `Unlocking ${target.selector} would lock ${add.size} other styles in ${where} one by one, past the ${STYLE_KEEP_LIMITS.patternsMax}-name limit of .stacki/styles.json. Unlock ${where} instead.`,
    );
  }
  const change = { add: [...add], remove: exactPatterns(keepList, [...targetNames]), lock: [], unlock: [covering] };
  // Postcondition: none of the target's names stays locked by this change.
  assert(
    change.add.every((name) => !targetNames.has(name)),
    'unlockOneChange: the unlocked row is not locked again',
  );
  return ok(change);
}

/**
 * Lock `target` (a stylesheet, or a folder ending in `/`) and drop the exact
 * name locks only its selectors use; a name another sheet's selector needs
 * stays, so locking here never unlocks anything elsewhere.
 */
export function lockSheetChange(report: SelectorReport, keepList: StyleKeepList, target: string): KeepListChange {
  assert(target !== '', 'lockSheetChange: the stylesheet or folder is named');
  assert(!keepList.lockedStylesheets.includes(target), 'lockSheetChange: the target is not locked yet');
  const inside = new Set<string>();
  const outside = new Set<string>();
  for (const entry of report.entries) {
    const names = verdictNames(entry.verdict);
    const side = coveredBy(target, entry.rel) ? inside : outside;
    for (const name of names) {
      side.add(name);
    }
  }
  const remove = keepList.keep.filter((pattern) => inside.has(pattern) && !outside.has(pattern));
  assert(
    remove.every((pattern) => !pattern.includes('*')),
    'lockSheetChange: wildcard patterns are edited in the file',
  );
  return { add: [], remove, lock: [target], unlock: [] };
}

/** Unlock a stylesheet or folder by its own entry; name locks are left as they are. */
export function unlockSheetChange(keepList: StyleKeepList, target: string): KeepListChange {
  assert(keepList.lockedStylesheets.includes(target), 'unlockSheetChange: the target is locked by its own entry');
  return { add: [], remove: [], lock: [], unlock: [target] };
}
