// Show a known class edit in the live canvas while the source write and Astro
// rebuild run. The later server patch remains authoritative for the final DOM.
import type { ClassNode } from './classNames';
import { elementClasses } from './classNames';
import { tellCanvas } from './canvasQuery';
import type { Attr } from '../../shared/page/pageNode';

export function previewClassProps(path: string | undefined, before: ClassNode | undefined, patch: Readonly<Record<string, Attr | undefined>>): void {
  if (!('class' in patch) && !('class:list' in patch)) {
    return;
  }
  const next = { ...before?.props, ...patch };
  const classAttr = next['class'];
  const classList = next['class:list'];
  const props = {
    ...(classAttr ? { class: classAttr } : {}),
    ...(classList ? { 'class:list': classList } : {}),
  };
  previewClassChange(path, before, { props });
}

export function previewClassChange(path: string | undefined, before: ClassNode | undefined, after: ClassNode | undefined): void {
  if (!path) {
    return;
  }
  const oldNames = new Set(staticClassNames(before));
  const newNames = new Set(staticClassNames(after));
  const add = [...newNames].filter((name) => !oldNames.has(name));
  const remove = [...oldNames].filter((name) => !newNames.has(name));
  if (add.length === 0 && remove.length === 0) {
    return;
  }
  tellCanvas({ type: 'avb:class-patch', path, add, remove });
}

function staticClassNames(node: ClassNode | undefined): readonly string[] {
  const props = node?.props;
  const classAttr = props?.['class'];
  const classList = props?.['class:list'];
  return [...elementClasses({ props: classAttr ? { class: classAttr } : {} }), ...elementClasses({ props: classList ? { 'class:list': classList } : {} })];
}

export function previewAddedClass(path: string | undefined, className: string): void {
  if (path) {
    tellCanvas({ type: 'avb:class-patch', path, add: [className], remove: [] });
  }
}
