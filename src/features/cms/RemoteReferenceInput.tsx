// A reference field of a connected CMS: a searchable choice among the published
// documents of the types it may point at. The choice is written as the CMS's
// own reference, `{ _type: "reference", _ref }`, keeping an array item's key.
import { remoteObject, type RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteReferenceOption } from '../../../shared/properties/cmsRemote';
import { remoteReferenceOptions } from '../../ipc/cmsConnectionsBridge';
import Dropdown from '../../ui/Dropdown';
import { useRemote } from './remoteCmsShared';
import { SanityTypeIcon, typeIcons } from './SanityTypeIcon';
import { REFERENCE_OPTIONS } from './remoteCmsCache';
import type { RemoteEditContext, RemoteValueProps } from './RemoteValueEditor';

// The "no document" choice; never a valid document id, which has no spaces.
const NONE = ' none';

export function RemoteReferenceInput(props: RemoteValueProps & { readonly to: readonly string[] }) {
  const options = useReferenceOptions(props.context, props.to);
  const icons = typeIcons(props.context.connectionId);
  const object = remoteObject(props.value);
  const current = object?.['_ref'];
  const chosen = typeof current === 'string' ? current : NONE;
  const known = options.some((option) => option.id === chosen);
  return (
    <Dropdown
      value={chosen}
      searchable={true}
      searchPlaceholder="Search…"
      options={[
        { value: NONE, label: 'None', dim: true },
        ...options.map((option) => ({
          value: option.id,
          label: option.title,
          icon: <SanityTypeIcon symbol={icons.get(option.type)} size={12} />,
        })),
        ...(known || chosen === NONE ? [] : [{ value: chosen, label: chosen, dim: true }]),
      ]}
      onChange={(id) => {
        if (id === NONE) {
          props.onChange(undefined);
        } else {
          props.onChange({ ...(object ?? {}), _type: 'reference', _ref: id });
        }
      }}
    />
  );
}

/** The documents these types hold, loaded once per set of types. */
export function useReferenceOptions(
  context: Pick<RemoteEditContext, 'projectPath' | 'connectionId'>,
  to: readonly string[],
): readonly RemoteReferenceOption[] {
  const { result } = useRemote(REFERENCE_OPTIONS, `${context.connectionId}:${to.join(',')}`, () =>
    remoteReferenceOptions(context.projectPath, context.connectionId, to),
  );
  return result?.ok ? result.value : [];
}

/** A reference's document title among loaded options, or its id. */
export function referenceTitle(
  value: RemoteValue | undefined,
  options: readonly RemoteReferenceOption[],
): string {
  const id = remoteObject(value)?.['_ref'];
  if (typeof id !== 'string') {
    return 'None';
  }
  return options.find((option) => option.id === id)?.title ?? id;
}
