# Central icons in Stacki

Stacki embeds selected icons from Central Icon System v1.35 by Iconists (David & Storm GbR).
These assets are covered by the [Iconists license](https://iconists.co/license). The repository's
MIT license covers Stacki's code. The Central drawings remain separately licensed.

The shared icon renderer uses Central's unfilled outlines with round joins and a 2px corner radius
on the original 24px grid. The 12px and 16px sizes use the 1.5px stroke variants for legibility.
The 20px, 24px, and 32px sizes use the 1px variants. Source variant IDs accompany the geometry.

File lists draw each file's type from one table (`src/ui/ElementIcons.tsx`, `fileLookOf`). Language and
tool marks come from the file's "Social Media & Brands" section: each is one filled component, exported
unchanged and coloured by a `--file-*` theme token. A type with no Central mark keeps the plain code icon
with no colour; never fill the gap from another icon set.
