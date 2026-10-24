import { assert } from '../../../shared/core/assert';

export interface ToolbarMeasurement {
  readonly id: string;
  readonly width: number;
  readonly priority: number;
}

// Toolbar controls are a small, fixed set; reject accidental unbounded menus.
const ACTIONS_MAX = 16;

export function toolbarOverflow(
  items: readonly ToolbarMeasurement[],
  available: number,
  moreWidth: number,
  gap: number,
): readonly string[] {
  assert(items.length <= ACTIONS_MAX, 'Toolbar action limit exceeded');
  assert(new Set(items.map((item) => item.id)).size === items.length, 'Duplicate toolbar action');
  assert(Number.isFinite(available), 'Toolbar width must be finite');
  assert(moreWidth >= 0, 'Invalid overflow button width');
  assert(Number.isFinite(moreWidth), 'Invalid overflow button width');
  assert(gap >= 0, 'Invalid toolbar gap');
  assert(Number.isFinite(gap), 'Invalid toolbar gap');
  for (const item of items) {
    assert(item.width >= 0, 'Invalid toolbar action width');
    assert(Number.isFinite(item.width), 'Invalid toolbar action width');
    assert(Number.isFinite(item.priority), 'Invalid toolbar action priority');
  }
  const total = items.reduce((sum, item) => sum + item.width + gap, -gap);
  if (total <= available) {
    return [];
  }
  // Reserve the menu first. Skip a large secondary control if a smaller one still fits.
  let remaining = Math.max(0, available - moreWidth);
  const hidden = new Set<string>();
  for (const item of [...items].sort((left, right) => right.priority - left.priority)) {
    const cost = item.width + gap;
    if (cost <= remaining) {
      remaining -= cost;
    } else {
      hidden.add(item.id);
    }
  }
  return items.filter((item) => hidden.has(item.id)).map((item) => item.id);
}
