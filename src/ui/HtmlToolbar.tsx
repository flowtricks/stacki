import { useState } from 'react';
import { safeHTMLLink } from './htmlFieldModel';

export interface HTMLCommand {
  readonly name: string;
  readonly value?: string;
}
interface Props {
  readonly source: boolean;
  readonly toggleSource: () => void;
  readonly command: (command: HTMLCommand) => void;
  readonly rememberSelection: () => void;
}
const FORMATS = [
  ['bold', 'Bold', 'B'],
  ['italic', 'Italic', 'I'],
  ['underline', 'Underline', 'U'],
  ['insertUnorderedList', 'Bulleted list', '• List'],
  ['insertOrderedList', 'Numbered list', '1. List'],
  ['removeFormat', 'Clear formatting', 'Clear'],
] as const;

export function HtmlToolbar({ source, toggleSource, command, rememberSelection }: Props) {
  const [link, setLink] = useState<string | undefined>();
  return (
    <>
      <div className="html-toolbar" role="group" aria-label="Text formatting">
        {!source && (
          <>
            <select
              aria-label="Text style"
              defaultValue=""
              onMouseDown={rememberSelection}
              onChange={(event) => {
                command({ name: 'formatBlock', value: event.target.value });
                const selectElement = event.target;
                selectElement.value = '';
              }}
            >
              <option value="" disabled>
                Text style
              </option>
              <option value="p">Paragraph</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
              <option value="blockquote">Quote</option>
            </select>
            {FORMATS.map(([name, label, text]) => (
              <button
                key={name}
                type="button"
                title={label}
                aria-label={label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => command({ name })}
              >
                {text}
              </button>
            ))}
            <button
              type="button"
              onMouseDown={rememberSelection}
              onClick={() => setLink(link === undefined ? '' : undefined)}
            >
              Link
            </button>
          </>
        )}
        <button
          type="button"
          className="html-source-toggle"
          aria-pressed={source}
          onClick={toggleSource}
        >
          {source ? 'Visual' : 'HTML'}
        </button>
      </div>
      {link !== undefined && !source && (
        <HtmlLink link={link} setLink={setLink} command={command} />
      )}
    </>
  );
}

interface LinkProps {
  readonly link: string;
  readonly setLink: (value: string | undefined) => void;
  readonly command: Props['command'];
}
function HtmlLink({ link, setLink, command }: LinkProps) {
  return (
    <form
      className="html-link"
      onSubmit={(event) => {
        event.preventDefault();
        if (safeHTMLLink(link)) {
          command({ name: 'createLink', value: link.trim() });
          setLink(undefined);
        }
      }}
    >
      <input
        aria-label="Link address"
        placeholder="https://example.com"
        value={link}
        onChange={(event) => setLink(event.target.value)}
      />
      <button type="submit" disabled={!safeHTMLLink(link)}>
        Apply
      </button>
      <button type="button" onClick={() => setLink(undefined)}>
        Cancel
      </button>
    </form>
  );
}
