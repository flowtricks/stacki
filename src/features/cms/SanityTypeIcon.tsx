// The icon a Sanity schema gives a document type (`icon: UserIcon`), drawn from
// Sanity's own icon set, as its Studio draws it: in the collection list, on a
// reference's row, and in a list row with no picture of its own. A type whose
// schema names no Sanity icon gets Stacki's collection icon. Each icon loads
// the first time it is shown (`@sanity/icons` splits them), so a project's
// icons cost only what it names.
import { Icon as SanityIcon, icons, type IconSymbol } from '@sanity/icons';
import { CollectionIcon } from '../../ui/Icons';
import { COLLECTIONS } from './remoteCmsCache';

export function SanityTypeIcon(props: {
  readonly symbol: string | undefined;
  readonly size: number;
}) {
  const { symbol } = props;
  if (symbol === undefined || !isSymbol(symbol)) {
    return <CollectionIcon size={props.size} />;
  }
  // Sanity draws on a 25-unit square with its own margin; a little larger
  // matches the visual size of Stacki's icons beside it.
  return (
    <SanityIcon
      symbol={symbol}
      className="sanity-type-icon"
      style={{ fontSize: Math.round(props.size * 1.35) }}
    />
  );
}

/** The icon symbol of each document type of a connection, from its collection list. */
export function typeIcons(connectionId: string): ReadonlyMap<string, string> {
  const collections = COLLECTIONS.get(connectionId);
  const known = collections?.ok ? collections.value : [];
  return new Map(
    known.flatMap((collection) =>
      collection.icon === undefined ? [] : [[collection.name, collection.icon] as const],
    ),
  );
}

function isSymbol(symbol: string): symbol is IconSymbol {
  return Object.hasOwn(icons, symbol);
}
