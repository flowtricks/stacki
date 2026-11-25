import { assert } from '../../../shared/core/assert';
import { pathText } from '../../../shared/core/boundary';

const QUERY_CHARS_MAX = 512;

export function PageSearchPath({ path, query }: { readonly path: string; readonly query: string }) {
  pathText(path);
  assert(query.length <= QUERY_CHARS_MAX, 'Page search: query length is bounded');
  const clean = query.trim();
  // Escape user input so punctuation in a slug is literal, never a regular expression.
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = clean ? path.split(new RegExp(`(${escaped})`, 'gi')) : [path];
  return (
    <span className="sub page-search-path">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span className="page-search-rest" key={index}>
            {part}
          </span>
        ),
      )}
    </span>
  );
}
