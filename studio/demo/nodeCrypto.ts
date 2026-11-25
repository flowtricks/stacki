// `node:crypto`'s createHash for sourcePlanner in the browser, where Web Crypto's
// digest is asynchronous and the planner is not. SHA-256 only, because that is all it
// asks for, and the digest has to match the server's for the same text.
import { sha256Hex } from '../src/shared/sha256';

export { sha256Hex };

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') {
    throw new Error(`Only sha256 is available here, not ${algorithm}`);
  }
  let text = '';
  const hash = {
    update(value: string) {
      text += value;
      return hash;
    },
    digest(encoding: string) {
      if (encoding !== 'hex') {
        throw new Error(`Only hex digests are available here, not ${encoding}`);
      }
      return sha256Hex(text);
    },
  };
  return hash;
}
