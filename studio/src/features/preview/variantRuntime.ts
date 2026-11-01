import { AsyncLocalStorage } from 'node:async_hooks';

export interface VariantOverride {
  readonly component: string;
  readonly target: string;
  readonly prop: string;
  readonly value: string | number | null;
}
declare global {
  // Vite's SSR module graph and the integration bundle share one request scope.
  var __studioVariantScope: AsyncLocalStorage<VariantOverride> | undefined;
}
export const variantScope = (globalThis.__studioVariantScope ??= new AsyncLocalStorage<VariantOverride>());

export function applyVariant(props: Record<string, unknown>, component: string) {
  const override = variantScope.getStore();
  const path = props['data-avb-p'];
  if (!override || override.component !== component || typeof path !== 'string' || path.split(' ')[0] !== override.target) {
    return;
  }
  if (override.value === null) {
    delete props[override.prop];
  } else {
    props[override.prop] = override.value;
  }
}

export function instrumentVariant(code: string, component: string, runtime: string): string {
  const setup =
    `import { applyVariant as __studioApplyVariant } from ${JSON.stringify(runtime)};\n` + `__studioApplyVariant(Astro.props, ${JSON.stringify(component)});\n`;
  return code.startsWith('---\n') ? `---\n${setup}${code.slice(4)}` : `---\n${setup}---\n${code}`;
}
