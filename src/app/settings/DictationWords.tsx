// Settings → Dictation → Vocabulary and Snippets: the person's own words (dictationVocabulary.ts).
// Vocabulary is a list of words written the person's way, optionally with what Whisper hears instead;
// names from the open project are offered as one-click suggestions. Snippets are a trigger to say and
// the text it writes, listed with a search. Each section has its Add button in its heading, and each
// row can be edited or deleted. Everything is edited in the app's own
// dialogs and kept on this computer (dictationStore.ts), never shared.
import { useEffect, useMemo, useState } from 'react';
import {
  parseSnippet,
  parseVocabularyEntry,
  VOCABULARY_LIMITS,
  type DictationWords,
  type Snippet,
  type VocabularyEntry,
} from '../../../shared/properties/voice/dictationVocabulary';
import { normalizeWords } from '../../../shared/properties/voice/dictationVocabulary';
import { aiMentions } from '../../features/ai/aiBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { reportErrorToast } from '../../ui/errorNotices';
import { ListViewIcon, PencilIcon, PlusIcon, SearchIcon, TextIcon, TrashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { SearchField } from '../../ui/SearchField';
import { Switch } from '../../ui/Switch';
import { SettingsEmpty, SettingsSection } from './SettingsLayout';

/** Project names offered as vocabulary at once. */
const SUGGESTIONS_MAX = 12;

export function DictationWordsRows({
  words,
  projectPath,
  onChange,
}: {
  readonly words: DictationWords;
  /** The project open in this window, whose component names are suggested; none on the welcome screen. */
  readonly projectPath: string | undefined;
  readonly onChange: (words: DictationWords) => void;
}) {
  return (
    <>
      <VocabularySection words={words} projectPath={projectPath} onChange={onChange} />
      <SnippetsSection words={words} onChange={onChange} />
    </>
  );
}

type WordEdit = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly entry: VocabularyEntry };

// Vocabulary: a list of words written the person's way, each with what Whisper hears instead when there is one;
// the open project's component names are offered under it as one-click chips.
function VocabularySection({
  words,
  projectPath,
  onChange,
}: {
  readonly words: DictationWords;
  readonly projectPath: string | undefined;
  readonly onChange: (words: DictationWords) => void;
}) {
  const translate = useTranslate();
  const [wordEdit, setWordEdit] = useState<WordEdit | undefined>(undefined);
  const suggestions = useProjectNames(projectPath, words.vocabulary);
  const addWord = (entry: VocabularyEntry): void => onChange({ ...words, vocabulary: [...words.vocabulary, entry] });
  return (
    <SettingsSection
      title={translate('dictation.words.vocabulary.label')}
      info={translate('dictation.words.vocabulary.info')}
      action={
        <button type="button" disabled={words.vocabulary.length >= VOCABULARY_LIMITS.entriesMax} onClick={() => setWordEdit({ kind: 'new' })}>
          <PlusIcon size={12} /> {translate('dictation.words.vocabulary.add')}
        </button>
      }
    >
      {words.vocabulary.length === 0 ? (
        <SettingsEmpty compact icon={<TextIcon size={16} />}>
          {translate('dictation.words.vocabulary.empty')}
        </SettingsEmpty>
      ) : (
        <ul className="dictation-rows">
          {words.vocabulary.map((entry) => (
            <li key={entry.word} className="dictation-row">
              <span className="dictation-row-text">
                <span className="dictation-row-title">{entry.word}</span>
                {entry.misheard !== undefined && (
                  <span className="dictation-row-detail">{translate('dictation.words.vocabulary.misheard', { misheard: entry.misheard })}</span>
                )}
              </span>
              <button
                type="button"
                className="ghost"
                aria-label={translate('dictation.words.vocabulary.edit', { word: entry.word })}
                onClick={() => setWordEdit({ kind: 'edit', entry })}
              >
                <PencilIcon size={12} />
              </button>
              <button
                type="button"
                className="ghost"
                aria-label={translate('dictation.words.vocabulary.remove', { word: entry.word })}
                onClick={() => onChange({ ...words, vocabulary: words.vocabulary.filter((each) => each !== entry) })}
              >
                <TrashIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {suggestions.length > 0 && (
        <div className="dictation-words-suggestions" role="group" aria-label={translate('dictation.words.vocabulary.suggestions')}>
          <span className="dictation-words-suggestions-label">{translate('dictation.words.vocabulary.suggestions')}</span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className="dictation-words-suggestion"
              aria-label={translate('dictation.words.vocabulary.suggestion', { word: name })}
              onClick={() => addWord({ word: name })}
            >
              <PlusIcon size={10} /> {name}
            </button>
          ))}
        </div>
      )}
      {wordEdit !== undefined && (
        <WordDialog
          initial={wordEdit.kind === 'edit' ? wordEdit.entry : undefined}
          taken={words.vocabulary.filter((each) => wordEdit.kind === 'new' || each !== wordEdit.entry).map((entry) => entry.word.toLowerCase())}
          onClose={() => setWordEdit(undefined)}
          onSave={(entry) => {
            const vocabulary =
              wordEdit.kind === 'edit' ? words.vocabulary.map((each) => (each === wordEdit.entry ? entry : each)) : [...words.vocabulary, entry];
            onChange({ ...words, vocabulary });
            setWordEdit(undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}

// Snippets: a trigger to say and the text it writes, listed with a search once there are enough to need one.
function SnippetsSection({ words, onChange }: { readonly words: DictationWords; readonly onChange: (words: DictationWords) => void }) {
  const translate = useTranslate();
  const [snippetEdit, setSnippetEdit] = useState<{ readonly kind: 'new' } | { readonly kind: 'edit'; readonly snippet: Snippet } | undefined>(undefined);
  const [search, setSearch] = useState('');
  const shown = words.snippets.filter((snippet) => {
    const query = normalizeWords(search);
    return query === '' || normalizeWords(`${snippet.trigger} ${snippet.expansion}`).includes(query);
  });
  const removeSnippet = async (snippet: Snippet): Promise<void> => {
    const answer = await confirmDialog({
      title: translate('dictation.words.snippets.deleteTitle'),
      body: translate('dictation.words.snippets.deleteBody', { trigger: snippet.trigger }),
      confirmLabel: translate('dictation.words.snippets.deleteConfirm'),
      danger: true,
    });
    if (answer === true) {
      onChange({ ...words, snippets: words.snippets.filter((each) => each !== snippet) });
    }
  };
  return (
    <SettingsSection
      title={translate('dictation.words.snippets.label')}
      info={translate('dictation.words.snippets.info')}
      action={
        <button type="button" disabled={words.snippets.length >= VOCABULARY_LIMITS.snippetsMax} onClick={() => setSnippetEdit({ kind: 'new' })}>
          <PlusIcon size={12} /> {translate('dictation.words.snippets.add')}
        </button>
      }
    >
      {words.snippets.length === 0 ? (
        <SettingsEmpty compact icon={<ListViewIcon size={16} />}>
          {translate('dictation.words.snippets.empty')}
        </SettingsEmpty>
      ) : (
        <>
          {words.snippets.length > 4 && (
            <SearchField
              label={translate('dictation.words.snippets.search')}
              value={search}
              clearLabel={translate('elements.panel.clearSearch')}
              onChange={setSearch}
            />
          )}
          {shown.length === 0 ? (
            <SettingsEmpty compact icon={<SearchIcon size={16} />}>
              {translate('dictation.words.snippets.noMatch')}
            </SettingsEmpty>
          ) : (
            <ul className="dictation-rows">
              {shown.map((snippet) => (
                <li key={snippet.trigger} className="dictation-row">
                  <span className="dictation-row-text">
                    <span className="dictation-row-title">{snippet.trigger}</span>
                    <span className="dictation-row-detail">{snippet.expansion.replace(/\s+/gu, ' ')}</span>
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    aria-label={translate('dictation.words.snippets.edit', { trigger: snippet.trigger })}
                    onClick={() => setSnippetEdit({ kind: 'edit', snippet })}
                  >
                    <PencilIcon size={12} />
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-label={translate('dictation.words.snippets.delete', { trigger: snippet.trigger })}
                    onClick={() => void removeSnippet(snippet)}
                  >
                    <TrashIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {snippetEdit !== undefined && (
        <SnippetDialog
          initial={snippetEdit.kind === 'edit' ? snippetEdit.snippet : undefined}
          taken={words.snippets.filter((each) => snippetEdit.kind === 'new' || each !== snippetEdit.snippet).map((each) => normalizeWords(each.trigger))}
          onClose={() => setSnippetEdit(undefined)}
          onSave={(snippet) => {
            const rest = snippetEdit.kind === 'edit' ? words.snippets.filter((each) => each !== snippetEdit.snippet) : words.snippets;
            onChange({ ...words, snippets: [...rest, snippet] });
            setSnippetEdit(undefined);
          }}
        />
      )}
    </SettingsSection>
  );
}

// The open project's component names (PascalCase file names), as vocabulary suggestions; none without a project.
// The files are asked of the main process for the project Settings names, not through the AI panel's store: that
// store learns a project only when the panel opens, and asking it before then asserted and took Settings down.
function useProjectNames(projectPath: string | undefined, vocabulary: readonly VocabularyEntry[]): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([]);
  useEffect(() => {
    setNames([]); // Another project, or none: the last one's names are not this one's.
    if (projectPath === undefined) {
      return undefined;
    }
    let live = true;
    aiMentions({ projectPath, query: '', kinds: ['file'] })
      .then((reply) => {
        if (!live || !reply.ok) {
          return;
        }
        const found = reply.value.flatMap((candidate) => {
          if (candidate.kind !== 'file') {
            return [];
          }
          const match = /([A-Z][A-Za-z0-9]{3,})\.astro$/u.exec(candidate.path);
          return match?.[1] === undefined ? [] : [match[1]];
        });
        setNames([...new Set(found)]);
      })
      .catch(() => undefined); // Suggestions are a convenience: a failed read leaves none, and the words stay editable.
    return () => {
      live = false;
    };
  }, [projectPath]);
  return useMemo(() => {
    const known = new Set(vocabulary.map((entry) => entry.word.toLowerCase()));
    return names.filter((name) => !known.has(name.toLowerCase())).slice(0, SUGGESTIONS_MAX);
  }, [names, vocabulary]);
}

function WordDialog({
  initial,
  taken,
  onClose,
  onSave,
}: {
  /** The word being edited; none when a new one is added. */
  readonly initial: VocabularyEntry | undefined;
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (entry: VocabularyEntry) => void;
}) {
  const translate = useTranslate();
  const [word, setWord] = useState(initial?.word ?? '');
  const [correcting, setCorrecting] = useState(initial?.misheard !== undefined);
  const [misheard, setMisheard] = useState(initial?.misheard ?? '');
  const title = translate(initial === undefined ? 'dictation.words.dialog.wordTitle' : 'dictation.words.dialog.wordEditTitle');
  // The fields the last submit refused wear the error look; why is said once, as a toast (never a paragraph in the dialog).
  const [refused, setRefused] = useState<ReadonlySet<'word' | 'misheard'>>(new Set());
  const refuse = (fields: ReadonlySet<'word' | 'misheard'>, message: string): void => {
    setRefused(fields);
    reportErrorToast(message);
  };
  const submit = (): void => {
    const missing = new Set<'word' | 'misheard'>();
    if (word.trim() === '') {
      missing.add('word');
    }
    if (correcting && misheard.trim() === '') {
      missing.add('misheard');
    }
    if (missing.size > 0) {
      refuse(missing, translate('dictation.words.dialog.required'));
      return;
    }
    if (taken.includes(word.trim().toLowerCase())) {
      refuse(new Set(['word']), translate('dictation.words.dialog.duplicate'));
      return;
    }
    try {
      onSave(parseVocabularyEntry(correcting ? { word, misheard } : { word }));
    } catch {
      refuse(new Set(['word', 'misheard']), translate('dictation.words.dialog.tooLong'));
    }
  };
  return (
    <Popup className="modal dictation-words-dialog" role="dialog" label={title} onClose={onClose}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="modal-header">{title}</div>
          <div className="modal-body dictation-words-dialog-body">
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.word')}</span>
              <input
                autoFocus
                value={word}
                maxLength={VOCABULARY_LIMITS.wordCharsMax}
                placeholder={translate('dictation.words.dialog.wordPlaceholder')}
                aria-invalid={refused.has('word') ? true : undefined}
                onChange={(event) => {
                  setWord(event.currentTarget.value);
                  setRefused(withoutField(refused, 'word'));
                }}
              />
            </label>
            <div className="dictation-words-toggle">
              <Switch label={translate('dictation.words.dialog.correct')} checked={correcting} onToggle={() => setCorrecting((value) => !value)} />
              <span>{translate('dictation.words.dialog.correct')}</span>
            </div>
            {correcting && (
              <label className="dictation-words-field">
                <span>{translate('dictation.words.dialog.misheard')}</span>
                <input
                  value={misheard}
                  maxLength={VOCABULARY_LIMITS.wordCharsMax}
                  placeholder={translate('dictation.words.dialog.misheardPlaceholder')}
                  aria-invalid={refused.has('misheard') ? true : undefined}
                  onChange={(event) => {
                    setMisheard(event.currentTarget.value);
                    setRefused(withoutField(refused, 'misheard'));
                  }}
                />
              </label>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary">
              {translate(initial === undefined ? 'dictation.words.dialog.add' : 'dictation.words.dialog.saveWord')}
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}

function SnippetDialog({
  initial,
  taken,
  onClose,
  onSave,
}: {
  readonly initial: Snippet | undefined;
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (snippet: Snippet) => void;
}) {
  const translate = useTranslate();
  const [trigger, setTrigger] = useState(initial?.trigger ?? '');
  const [expansion, setExpansion] = useState(initial?.expansion ?? '');
  // The fields the last submit refused wear the error look; why is said once, as a toast (never a paragraph in the dialog).
  const [refused, setRefused] = useState<ReadonlySet<'trigger' | 'expansion'>>(new Set());
  const refuse = (fields: ReadonlySet<'trigger' | 'expansion'>, message: string): void => {
    setRefused(fields);
    reportErrorToast(message);
  };
  const title = translate(initial === undefined ? 'dictation.words.dialog.snippetTitle' : 'dictation.words.dialog.snippetEditTitle');
  const submit = (): void => {
    const missing = new Set<'trigger' | 'expansion'>();
    if (normalizeWords(trigger) === '') {
      missing.add('trigger');
    }
    if (expansion.trim() === '') {
      missing.add('expansion');
    }
    if (missing.size > 0) {
      refuse(missing, translate('dictation.words.dialog.required'));
      return;
    }
    if (taken.includes(normalizeWords(trigger))) {
      refuse(new Set(['trigger']), translate('dictation.words.dialog.duplicate'));
      return;
    }
    try {
      onSave(parseSnippet({ trigger, expansion }));
    } catch {
      refuse(new Set(['trigger', 'expansion']), translate('dictation.words.dialog.tooLong'));
    }
  };
  return (
    <Popup className="modal dictation-words-dialog" role="dialog" label={title} onClose={onClose}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="modal-header">{title}</div>
          <div className="modal-body dictation-words-dialog-body">
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.trigger')}</span>
              <input
                autoFocus
                value={trigger}
                maxLength={VOCABULARY_LIMITS.triggerCharsMax}
                placeholder={translate('dictation.words.dialog.triggerPlaceholder')}
                aria-invalid={refused.has('trigger') ? true : undefined}
                onChange={(event) => {
                  setTrigger(event.currentTarget.value);
                  setRefused(withoutField(refused, 'trigger'));
                }}
              />
            </label>
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.expansion')}</span>
              <textarea
                rows={4}
                value={expansion}
                maxLength={VOCABULARY_LIMITS.expansionCharsMax}
                aria-invalid={refused.has('expansion') ? true : undefined}
                onChange={(event) => {
                  setExpansion(event.currentTarget.value);
                  setRefused(withoutField(refused, 'expansion'));
                }}
              />
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary">
              {translate('dictation.words.dialog.save')}
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}

function withoutField<Field extends string>(fields: ReadonlySet<Field>, field: Field): ReadonlySet<Field> {
  if (!fields.has(field)) {
    return fields;
  }
  const next = new Set(fields);
  next.delete(field);
  return next;
}
