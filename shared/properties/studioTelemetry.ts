// Third-party command-line tools report usage on their own unless told not to:
// Astro on every `astro dev` and `astro build`, Wrangler and Vercel on every
// deploy. Studio promises no usage tracking, so every process that hosts Studio
// starts with these values and the tools it runs inherit them, publishing
// included, because `publishEnvironment()` copies the host's environment.
//
// Only Studio's own launch points apply this. Desktop's canvas server and Desktop's
// publishes run from a different process, so they keep their environment.

export const STUDIO_TELEMETRY_DISABLED = {
  ASTRO_TELEMETRY_DISABLED: '1',
  VERCEL_TELEMETRY_DISABLED: '1',
  WRANGLER_SEND_METRICS: 'false',
} as const satisfies Readonly<Record<string, string>>;

/** The opt-outs win over inherited values: a shell's `WRANGLER_SEND_METRICS=true` must not reopen tracking. */
export function withStudioTelemetryDisabled(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return { ...environment, ...STUDIO_TELEMETRY_DISABLED };
}
