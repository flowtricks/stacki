// Settings → Style tags → New style tags: what a `<style>` tag starts with when the Style panel creates one.
// Its own tab, so it is found where it is looked for; the Style panel's "Add custom styles in" list links
// here ("Style tag defaults…").
//
// The whole setting is one highlighted code block holding the tag itself, `<style is:global>` … `</style>`:
// the block is its own preview. The person edits the opening tag's attributes and the content between the
// tags; the tag cannot become anything else (styleTagEditor.ts locks `<style`, the opening `>` and
// `</style>`). Each change is checked as it is typed: attributes that do not parse (newStyleTag.ts
// parseStyleTagAttributes) or a template that cannot place rules turn the block red with one word and are
// not saved; a valid one is saved after a pause to the `newStyleTag` section of `.stacki/styles.json`,
// through src/ipc/newStyleTagBridge.ts, which leaves the rest of the file alone. Reading never writes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  DEFAULT_NEW_STYLE_TAG,
  NEW_STYLE_TAG_RULES_TOKEN,
  parseStyleTagAttributes,
  templateFrame,
  type NewStyleTagSettings,
} from '../../../shared/properties/newStyleTag';
import { readNewStyleTag, writeNewStyleTag } from '../../ipc/newStyleTagBridge';
import { publishNewStyleTagSettings } from '../../features/style/model/newStyleTagSettings';
import { useTranslate } from '../../lib/i18n/useTranslate';
import CodeEditor from '../../ui/CodeEditor';
import { CodeInline } from '../../ui/CodeBlock';
import { Skeleton } from '../../ui/Skeleton';
import { SettingsNotice, SettingsSaveRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { can } from '../../../shared/properties/projectRoles';
import { styleTagLock, styleTagParts, styleTagText } from './styleTagEditor';
import './styleTagSettings.css';

/** How long typing pauses before the block is saved: one save per thought, not per key. */
const SAVE_DELAY_MS = 600;

/**
 * The Style tags tab: the section, its save indicator, and the permission that governs it. Style
 * tags are part of the project's style setup, so the breakpoints permission decides who edits them
 * (Settings.tsx accessTabOf), as it did while the section lived under Breakpoints.
 */
export function StyleTagSettingsPage(props: { readonly projectPath: string }) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const indicator = useSaveIndicator();
  return (
    // A section of its own, as every Settings page is: the panel spaces its sections, and the save row sits above the first.
    <section aria-label={translate('settings.tab.styles')}>
      <SettingsSaveRow saving={indicator.state} />
      <StyleTagSettings projectPath={props.projectPath} editable={can(role, 'settings:breakpoints')} track={indicator.track} />
    </section>
  );
}

type Loaded = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly saved: NewStyleTagSettings };

/** The settings a block's text says, or undefined when its attributes or its template cannot be saved. */
export function styleTagSettingsOf(text: string): NewStyleTagSettings | undefined {
  const parts = styleTagParts(text);
  if (parts === undefined) {
    return undefined;
  }
  const attributes = parseStyleTagAttributes(parts.attributes);
  if (!attributes.ok) {
    return undefined;
  }
  if (!templateFrame(parts.content).ok) {
    return undefined;
  }
  return { attributes: attributes.attributes, content: dedented(parts.content) };
}

// The content without the indentation every line shares: the editor indents what is typed inside the
// tag, and the tag the panel writes indents its body in the file's own unit (firstStyleBlock.ts
// styleBlockInner), so a template saved indented would be indented twice.
function dedented(content: string): string {
  const lines = content.split('\n');
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  assert(common >= 0, 'dedented: an indentation is not negative');
  return lines.map((line) => line.slice(Math.min(common, /^[ \t]*/.exec(line)?.[0].length ?? 0))).join('\n');
}

export function StyleTagSettings(props: { readonly projectPath: string; readonly editable: boolean; readonly track: <T>(save: Promise<T>) => Promise<T> }) {
  const { projectPath, editable, track } = props;
  const translate = useTranslate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [text, setText] = useState(() => styleTagText(DEFAULT_NEW_STYLE_TAG));
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Made once: the editor reads its extensions when it is made, and the lock never changes.
  const lock = useMemo(() => styleTagLock(), []);
  useEffect(() => {
    let live = true;
    const show = (saved: NewStyleTagSettings): void => {
      setLoaded({ kind: 'ready', saved });
      setText(styleTagText(saved));
    };
    readNewStyleTag(projectPath).then(
      (saved) => {
        if (live) {
          show(saved);
        }
      },
      (failure: unknown) => {
        if (live) {
          show(DEFAULT_NEW_STYLE_TAG);
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
  const change = (next: string): void => {
    setText(next);
    clearTimeout(timer.current);
    const settings = styleTagSettingsOf(next);
    setInvalid(settings === undefined);
    if (settings !== undefined) {
      timer.current = setTimeout(() => save(settings), SAVE_DELAY_MS);
    }
  };

  if (loaded.kind === 'loading') {
    return (
      <SettingsSection title={translate('settings.styleTags.title')}>
        <Skeleton height="96px" radius="12px" />
      </SettingsSection>
    );
  }
  const hint = translate('settings.styleTags.hint', { token: '\u0000' }).split('\u0000');
  return (
    <SettingsSection title={translate('settings.styleTags.title')} info={translate('settings.styleTags.info')}>
      <div className="style-tags-cards">
        {problem !== undefined && <SettingsNotice message={problem} />}
        <div className="style-tags-editor" data-readonly={editable ? undefined : ''} data-invalid={invalid ? '' : undefined}>
          <CodeEditor
            key={projectPath}
            language="html"
            indentation="spaces"
            chrome="minimal"
            value={text}
            extensions={lock}
            onChange={editable ? change : undefined}
          />
          {invalid && (
            <span className="style-tags-invalid" role="alert">
              {translate('settings.styleTags.invalid')}
            </span>
          )}
        </div>
        <p className="style-tags-caption">
          {hint[0]}
          <CodeInline text={NEW_STYLE_TAG_RULES_TOKEN} language="css" />
          {hint[1]}
        </p>
      </div>
    </SettingsSection>
  );
}
