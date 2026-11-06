import CodeEditor from '../../../vendor/stacki/src/ui/CodeEditor';
import { languageFor } from '../../../vendor/stacki/src/ui/codeHighlight';
import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useState } from 'react';
import type { SharedDocument } from '../collaboration/useDocument';
import { ValueFields } from '../../shared/ui/ValueFields';
import { collectionContent } from './content';

export function CollectionEditor({ document }: { document: SharedDocument }) {
  const [raw, setRaw] = useState(false);
  const source = document.text.toString();
  const { content, problem } = parseContent(document.file, source);
  function replace(text: string) {
    document.edit({ start: 0, end: document.text.length, text });
  }
  return (
    <div className="collection-editor">
      <div className="collection-heading">
        <div>
          <span className="eyebrow">Collection entry</span>
          <h1>{document.file.split('/').at(-1)}</h1>
        </div>
        <button onClick={() => setRaw(!raw)}>{raw ? 'Fields' : 'Source'}</button>
      </div>
      {content && !raw ? (
        <div className="collection-fields">
          {Object.entries(content.fields).map(([key, value]) => (
            <div className="studio-field" key={key}>
              <span>{key}</span>
              <ValueFields
                label={key}
                value={value}
                change={(next) => {
                  if (content) {
                    replace(content.change(key, next));
                  }
                }}
              />
            </div>
          ))}
          {content.body !== undefined && (
            <label className="studio-field">
              <span>Body</span>
              <textarea
                aria-label="Body"
                rows={18}
                value={content.body}
                onChange={(event) => {
                  const body = content?.body ?? '';
                  document.edit({
                    start: source.length - body.length,
                    end: source.length,
                    text: event.target.value,
                  });
                }}
              />
            </label>
          )}
        </div>
      ) : (
        <>
          <ErrorToast message={problem} />
          {!problem && <p className="muted">Changes are shared live.</p>}
          <div aria-label="Collection source" className="source-editor" role="group">
            <CodeEditor key={document.file} language={languageFor(document.file)} value={source} onChange={replace} />
          </div>
        </>
      )}
    </div>
  );
}

function parseContent(file: string, source: string) {
  try {
    return { content: collectionContent(file, source), problem: '' };
  } catch (error) {
    return {
      content: undefined,
      problem: error instanceof Error ? error.message : 'Invalid collection content',
    };
  }
}
