import React from 'react';
import Dropdown from './Dropdown.jsx';
import { FileIcon } from './Icons.jsx';

// Which entry of a dynamic route ([slug].astro) the canvas is rendered against.
//
// The route itself is a pattern, so there is nothing to preview until one of
// getStaticPaths' entries is chosen — /posts/[slug] is a 404, /posts/hello is a
// page. Only the data changes here: the template is shared by every entry, so
// whatever gets edited applies to all of them.
//
// Every option is a page that a collection generates, so it reads as one: the
// page glyph and the purple the rest of the app gives generated routes, in the
// Pages panel and the title bar. The list is as long as the collection is, so
// it is always searchable — a threshold would only mean the box appears when a
// project crosses some number of posts, which is a worse thing to learn than
// "the box is always there".
//
// Live preview is off. Each option is a full page navigation, so skimming the
// list would reload the canvas once per hover.
export default function DynamicPicker({ entries, index, onPick, error, pattern }) {
  if (error) {
    return (
      <span className="route-chip is-error" title={error}>
        getStaticPaths failed
      </span>
    );
  }
  if (!entries.length) {
    return (
      <span
        className="route-chip"
        title={`${pattern} has no paths to preview — getStaticPaths returned nothing.`}
      >
        No paths
      </span>
    );
  }
  return (
    <span className="route-picker" title="Which entry the canvas is showing">
      <Dropdown
        className="route-dd collection"
        menuClassName="route-menu collection"
        value={String(index)}
        options={entries.map((e, i) => ({
          value: String(i),
          label: e.label,
          icon: <FileIcon size={12} />,
        }))}
        onChange={(v) => onPick(Number(v))}
        livePreview={false}
        searchable
        searchPlaceholder="Search entries…"
      />
    </span>
  );
}
