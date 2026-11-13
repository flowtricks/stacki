// Durable node keys (docs/apps.md, "Durable node keys"). A node id lasts as
// long as the open page's session: Desktop carries ids across edits by
// source mapping (src/editor/nodeHandles.ts), but reopening the page, an edit
// made outside Stacki, or Studio (whose ids are positions) mints new ones. An
// app that remembers an element between sessions asks for a key instead.
//
// The key lives in the markup, as one `data-stacki-key` attribute written only
// when an app asks (`node.key`), as one undo step. It is the one design that
// survives every edit — moves, wraps, renames, outside edits, Git merges,
// another editor — because it travels with the element's own source. A
// structural fingerprint with a stored mapping writes nothing, but it guesses:
// it breaks when the element's surroundings change, and it cannot tell two
// identical elements apart at all.
//
// Identical twins: once keyed, each element has its own key, so twins are
// distinct. What can copy a key is duplicating a keyed element (⌘D, copy and
// paste, or by hand): two elements then carry one key. `node.find` answers the
// first in document order (the original, for a duplicate placed after it), and
// `node.key` on the later copy writes it a fresh key.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, NODE_KEY_ATTRIBUTE, parseNodeKey, type AppNodeKeyOutcome, type AppNodeView } from '../../../shared/properties/appsRpc';

/** What keying asks of the host: the open page's elements and its attribute edit. */
export interface NodeKeyHost {
  readonly node: (nodeId: string) => AppNodeView | undefined;
  readonly tree: () => readonly AppNodeView[];
  /** Writes the attribute as one undo step, or says why it cannot. */
  readonly setAttribute: (
    nodeId: string,
    name: string,
    value: string,
  ) => Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }>;
}

const KEY_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const KEY_RANDOM_CHARS = 12;

/** A fresh key: `k` and 12 random letters or digits (about 62 bits, so two never meet in one project). */
export function mintNodeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_RANDOM_CHARS));
  let key = 'k';
  for (const byte of bytes) {
    key += KEY_ALPHABET[byte % KEY_ALPHABET.length] ?? '0';
  }
  assert(key.length === KEY_RANDOM_CHARS + 1, 'A key has its fixed length');
  assert(parseNodeKey(key) === key, 'A minted key is one find accepts');
  return key;
}

/** `node.key`: the element's key, written first when it has none of its own. */
export async function nodeKey(host: NodeKeyHost, nodeId: string): Promise<AppNodeKeyOutcome> {
  const node = host.node(nodeId);
  if (node === undefined) {
    return { applied: false, reason: 'No element has that id on the open page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  if (node.kind !== 'element' && node.kind !== 'component') {
    return { applied: false, reason: 'Only an element or a component carries a key; text and expressions hold no attributes' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  const existing = ownKey(node);
  if (existing !== undefined && keyHolders(host.tree(), existing)[0] === nodeId) {
    return { applied: true, key: existing };
  }
  // No key, or the later copy of a duplicated one: a fresh key, one undo step.
  const key = mintNodeKey();
  const outcome = await host.setAttribute(nodeId, NODE_KEY_ATTRIBUTE, key);
  if (!outcome.applied) {
    return outcome;
  }
  assert(key !== existing, 'A written key is a new one');
  return { applied: true, key };
}

/** `node.find`: the open page's element carrying `key`, the first in document order. */
export function findNodeByKey(roots: readonly AppNodeView[], key: string): string | undefined {
  return keyHolders(roots, key)[0];
}

/** Ids of the elements carrying `key`, in document order. */
export function keyHolders(roots: readonly AppNodeView[], key: string): readonly string[] {
  const holders: string[] = [];
  const stack = [...roots].reverse();
  for (let visited = 0; stack.length > 0; visited += 1) {
    assert(visited < APP_RPC_LIMITS.treeNodesMax * 2, 'A key search is bounded by the reply bound');
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (ownKey(node) === key) {
      holders.push(node.id);
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return holders;
}

/** The key an element carries, when it is one Stacki could have minted: a hand-written value is no key. */
export function ownKey(node: AppNodeView): string | undefined {
  const value = Object.hasOwn(node.attributes, NODE_KEY_ATTRIBUTE) ? node.attributes[NODE_KEY_ATTRIBUTE] : undefined;
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseNodeKey(value);
  } catch {
    return undefined; // Not a key's shape: treated as no key, and replaced when an app asks for one.
  }
}
