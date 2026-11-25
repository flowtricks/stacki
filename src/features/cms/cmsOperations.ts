import type { SchemaOperations } from './CmsSettings';
import type { DeclaredTypes } from './cmsTypes';
import { applyToItems, fieldsAt, objectsAt, putKey, seedEntry, labelize, renameKey, dropKey, orderKeys } from './cmsSchema';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

interface OperationOptions {
  readonly items: readonly unknown[];
  readonly declared: DeclaredTypes;
  readonly commit: (items: readonly unknown[]) => void;
  readonly saveDeclared: (declared: DeclaredTypes) => Promise<void>;
  readonly report: (message: string) => void;
  /** Words the messages in the person's language; English when absent. */
  readonly translate?: Translator | undefined;
}
// Schema changes rebuild every affected item and the matching declaration paths.
// Both APIs are readonly; only newly constructed arrays and objects are changed.
export function createCmsSchemaOperations(options: OperationOptions): SchemaOperations {
  const { items, declared, commit, saveDeclared, report } = options;
  assert(items.length <= BOUNDARY_LIMITS.itemsMax, 'CMS schema: item limit exceeded');
  const entries = Object.entries(declared);
  assert(entries.length <= BOUNDARY_LIMITS.itemsMax, 'CMS schema: declaration limit exceeded');
  return {
    onAddField: (path, key, type) => {
      if (!key) {
        return;
      }
      if (fieldsAt(items, path).some((field) => field.key === key)) {
        return;
      }
      void saveDeclared({ ...declared, [[...path, key].join('.')]: type });
      const parent = path.slice(0, -1);
      const holder = path.at(-1);
      if (holder !== undefined && objectsAt(items, path).length === 0) {
        commit(applyToItems(items, parent, seedEntry(holder, key, type)));
        return;
      }
      commit(applyToItems(items, path, putKey(key, type)));
    },
    onRenameField: (path, from, to) => {
      if (!to || to === from) {
        return false;
      }
      if (fieldsAt(items, path).some((field) => field.key === to)) {
        report((options.translate ?? ENGLISH_TRANSLATE)('cms.operations.fieldExists', { name: labelize(to) }));
        return false;
      }
      const fromPath = [...path, from].join('.');
      const toPath = [...path, to].join('.');
      if (entries.some(([key]) => key === fromPath || key.startsWith(fromPath + '.'))) {
        void saveDeclared(
          Object.fromEntries(
            entries.map(([key, type]) => [key === fromPath || key.startsWith(fromPath + '.') ? toPath + key.slice(fromPath.length) : key, type]),
          ),
        );
      }
      commit(applyToItems(items, path, renameKey(from, to)));
      return true;
    },
    onRemoveField: (path, key) => {
      const gone = [...path, key].join('.');
      const retained = entries.filter(([name]) => name !== gone && !name.startsWith(gone + '.'));
      if (retained.length !== entries.length) {
        void saveDeclared(Object.fromEntries(retained));
      }
      commit(applyToItems(items, path, dropKey(key)));
    },
    onReorderFields: (path, keys) => commit(applyToItems(items, path, orderKeys(keys))),
  };
}
