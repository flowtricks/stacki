// The instructions Stacki bundles for the AI panel's built-in chips (App builder
// instructions). The text belongs to the feature that owns it (the Apps panel
// generates it from docs/apps-prompt.md), and the chip that carries it belongs to
// the AI panel; features may not import each other, so the owner provides its text
// here, at load, and the panel reads it by id. An id with no provider is a bundle
// that forgot to load its owner: reading it asserts rather than sending a chip with
// no words.
import { assert } from '../../shared/core/assert';
import type { BuiltinChipId } from '../../shared/properties/ai/mentions';

const providers = new Map<BuiltinChipId, () => string>();

/** Registers where `id`'s text comes from. Registering an id again replaces the provider (a hot reload loads its owner twice). */
export function provideBuiltinInstructions(id: BuiltinChipId, text: () => string): void {
  providers.set(id, text);
}

/** The bundled text for `id`; asserts when no owner has provided it. */
export function builtinInstructionsText(id: BuiltinChipId): string {
  const provider = providers.get(id);
  assert(provider !== undefined, `builtinInstructionsText: nothing provides the "${id}" instructions`);
  return provider();
}
