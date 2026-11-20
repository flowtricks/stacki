// Placeholder replaced by the passkey commit; declared early because builtIn.ts names the type.
export interface PasskeyStore {
  readonly handleActive: (handle: string) => Promise<boolean>;
}
