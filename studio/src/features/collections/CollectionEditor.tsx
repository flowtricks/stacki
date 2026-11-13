import CodeEditor from '../../../vendor/stacki/src/ui/CodeEditor';
import { codeIndentStyleFor } from '../../../vendor/stacki/src/ui/codeEditorIndent';
import { languageFor } from '../../../vendor/stacki/src/ui/codeHighlight';
import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import type { Translator } from '../../../vendor/stacki/src/lib/i18n/localeContext';
import { useState } from 'react';
import type { SharedDocument } from '../collaboration/useDocument';
import { ValueFields } from '../../shared/ui/ValueFields';
import { collectionContent } from './content';

export function CollectionEditor({ document }: { document: SharedDocument }) {
  const translate = useTranslate();
  const [raw, setRaw] = useState(false);
  const source = document.text.toString();
  const { content, problem } = parseContent(document.file, source, translate);
  function replace(text: string) {
    document.edit({ start: 0, end: document.text.length, text });
  }
  return (
    <div className="collection-editor">
      <div className="collection-heading">
        <div>
          <span className="eyebrow">{translate('cmsConnections.collection.entry')}</span>
          <h1>{document.file.split('/').at(-1)}</h1>
        </div>
        <button onClick={() => setRaw(!raw)}>{raw ? translate('contentUi.form.fields') : translate('cmsConnections.collection.source')}</button>
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
              <span>{translate('contentUi.body.title')}</span>
              <textarea
                aria-label={translate('contentUi.body.title')}
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
          {!problem && <p className="muted">{translate('cmsConnections.collection.shared')}</p>}
          <div aria-label={translate('cmsConnections.collection.sourceLabel')} className="source-editor" role="group">
            <CodeEditor
              key={document.file}
              language={languageFor(document.file)}
              indentation={codeIndentStyleFor(document.file) === 'spaces' ? 'spaces' : 'document'}
              value={source}
              onChange={replace}
            />
          </div>
        </>
      )}
    </div>
  );
}

function parseContent(file: string, source: string, translate: Translator) {
  try {
    return { content: collectionContent(file, source), problem: '' };
  } catch (error) {
    return {
      content: undefined,
      problem: error instanceof Error ? error.message : translate('cmsConnections.collection.invalid'),
    };
  }
}
