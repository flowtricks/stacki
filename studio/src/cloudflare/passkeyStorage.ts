// Durable Object storage as the passkey store's key-value interface. The transaction wrapper is what makes spending an
// invite, answering a challenge and advancing a counter atomic.
import type { KeyValueStorage, StorageOperations } from '../features/auth/providers/passkeyStore';

export function durableStorage(storage: DurableObjectStorage): KeyValueStorage {
  const operations = (target: DurableObjectStorage | DurableObjectTransaction): StorageOperations => ({
    get: (key) => target.get(key),
    put: (key, value) => target.put(key, value),
    delete: (key) => target.delete(key),
    list: (options) => target.list({ prefix: options.prefix, limit: options.limit }),
  });
  return {
    ...operations(storage),
    transaction: (closure) => storage.transaction((transaction) => closure(operations(transaction))),
  };
}
