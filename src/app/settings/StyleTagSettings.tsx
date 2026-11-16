// Settings → Breakpoints → Style tags: what a `<style>` tag starts with when the Style panel creates one.
// Two cards in the Breakpoints card language (filled surfaces, no borders): a switch for `is:global`, and a CSS
// editor for the tag's initial content with the rules placeholder explained under it and a live preview of the tag
// that would be created. Both save at once to the `newStyleTag` section of `.stacki/styles.json`
// (shared/properties/newStyleTag.ts), through src/ipc/newStyleTagBridge.ts, which leaves the rest of the file alone.
// A template that cannot place rules (an unclosed brace, a repeated or misplaced placeholder) is never saved: the
// card says why and keeps what was typed. Reading never writes; the file is created by the first change.
import { useEffect, useRef, useState } from 'react';
import {
  LEGACY_NEW_STYLE_TAG,
  NEW_STYLE_TAG_RULES_TOKEN,
  newStyleTagPreview,
  templateFrame,
  type NewStyleTagSettings,
  type TemplateErrorCode,
} from '../../../shared/properties/newStyleTag';
import { readNewStyleTag, writeNewStyleTag } from '../../ipc/newStyleTagBridge';
import { publishNewStyleTagSettings } from '../../features/style/model/newStyleTagSettings';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import CodeEditor from '../../ui/CodeEditor';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { Skeleton } from '../../ui/Skeleton';
import { Switch } from '../../ui/Switch';
import { SettingsNotice, SettingsRow, SettingsSection } from './SettingsLayout';
import './styleTagSettings.css';

/** How long typing pauses before the template is saved: one save per thought, not per key. */
const SAVE_DELAY_MS = 600;

const TEMPLATE_ERRORS: Record<TemplateErrorCode, MessageKey> = {
  unbalanced: 'settings.styleTags.error.unbalanced',
  'repeated-placeholder': 'settings.styleTags.error.repeated',
  'placeholder-in-rule': 'settings.styleTags.error.inRule',
};

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly saved: NewStyleTagSettings };

export function StyleTagSettings(props: { readonly projectPath: string; readonly editable: boolean; readonly track: <T>(save: Promise<T>) => Promise<T> }) {
  const { projectPath, editable, track } = props;
  const translate = useTranslate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [draft, setDraft] = useState<NewStyleTagSettings>(LEGACY_NEW_STYLE_TAG);
  const [problem, setProblem] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    readNewStyleTag(projectPath).then(
      (saved) => {
        if (live) {
          setLoaded({ kind: 'ready', saved });
          setDraft(saved);
        }
      },
      (failure: unknown) => {
        if (live) {
          setLoaded({ kind: 'ready', saved: LEGACY_NEW_STYLE_TAG });
          setProblem(translate('settings.styleTags.error.save', { message: failure instanceof Error ? failure.message : String(failure) }));
        }
      },
    );
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, [projectPath, translate]);

  const save = (next: NewStyleTagSettings): void => {
    track(writeNewStyleTag(projectPath, next)).then(
      (written) => {
        setProblem(undefined);
        setLoaded({ kind: 'ready', saved: written });
        // The Style panel's next write already uses it.
        publishNewStyleTagSettings(written);
      },
      (failure: unknown) => setProblem(translate('settings.styleTags.error.save', { message: failure instanceof Error ? failure.message : String(failure) })),
    );
  };
  const changeContent = (content: string): void => {
    const next = { ...draft, content };
    setDraft(next);
    clearTimeout(timer.current);
    const frame = templateFrame(content);
    if (!frame.ok) {
      setProblem(translate(TEMPLATE_ERRORS[frame.error.code]));
      return;
    }
    setProblem(undefined);
    timer.current = setTimeout(() => save(next), SAVE_DELAY_MS);
  };
  const toggleGlobal = (): void => {
    const next: NewStyleTagSettings = { ...draft, scope: draft.scope === 'global' ? 'scoped' : 'global' };
    setDraft(next);
    // A half-typed template waits for its own save; the switch saves the last valid text.
    if (templateFrame(next.content).ok) {
      clearTimeout(timer.current);
      save(next);
    }
  };

  if (loaded.kind === 'loading') {
    return (
      <SettingsSection title={translate('settings.styleTags.title')}>
        <Skeleton height="72px" radius="12px" />
        <Skeleton height="160px" radius="12px" />
      </SettingsSection>
    );
  }
  const caption = translate('settings.styleTags.caption', { token: '\u0000' }).split('\u0000');
  return (
    <SettingsSection title={translate('settings.styleTags.title')} info={translate('settings.styleTags.info')}>
      <div className="style-tags-cards">
        {problem !== undefined && <SettingsNotice message={problem} />}
        <div className="style-tags-card">
          <SettingsRow label={translate('settings.styleTags.global')} info={translate('settings.styleTags.globalInfo')}>
            <Switch label={translate('settings.styleTags.global')} checked={draft.scope === 'global'} disabled={!editable} onToggle={toggleGlobal} />
          </SettingsRow>
        </div>
        <div className="style-tags-card">
          <span className="style-tags-label">{translate('settings.styleTags.content')}</span>
          <div className="style-tags-editor" data-readonly={editable ? undefined : ''}>
            <CodeEditor key={projectPath} language="css" value={draft.content} onChange={editable ? changeContent : undefined} />
          </div>
          <p className="style-tags-caption">
            {caption[0]}
            <CodeInline text={NEW_STYLE_TAG_RULES_TOKEN} language="css" />
            {caption[1]}
          </p>
          <span className="style-tags-label">{translate('settings.styleTags.preview')}</span>
          <CodeBlock className="style-tags-preview" text={newStyleTagPreview(draft)} language="html" label={translate('settings.styleTags.preview')} />
        </div>
      </div>
    </SettingsSection>
  );
}
