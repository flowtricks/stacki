// Settings → New style locations: where a style goes when the Style panel creates one, for a page and for a
// component. Its own tab, so it is found where it is looked for; the Style panel's "Add custom styles in" list
// links here ("New style locations…").
//
// Each scope (a page, a component) chooses ONE place: "Create a style tag" in the open file, or an existing CSS
// file of the project, picked from a dropdown of the project's stylesheets by path (never a native select). With
// a style tag chosen, one highlighted code block shows the tag itself, `<style is:global>` … `</style>`: the
// block is its own preview. The person edits the opening tag's attributes and the content between the tags; the
// tag cannot become anything else (styleTagEditor.ts locks `<style`, the opening `>` and `</style>`). Each change
// is checked as it is typed: attributes that do not parse (newStyleTag.ts parseStyleTagAttributes) or a template
// that cannot place rules turn the block red with one word and are not saved. A chosen file that is no longer in
// the project shows a warning chip, and the panel writes the scope's style tag until it is picked again, so
// nothing is ever written to a path that was not found (newStyleLocations.ts effectiveLocation).
//
// A choice applies at once: the panel's store (model/newStyleTagSettings.ts) is updated as it is made, and the
// `newStyleLocations` section of `.stacki/styles.json` is written behind it, in order, through
// src/ipc/newStyleTagBridge.ts, which leaves the rest of the file alone. Reading never writes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  locationHealth,
  stylesheetChoices,
  withFile,
  withTag,
  withTagSettings,
  type NewStyleLocation,
  type NewStyleLocations,
  type NewStyleScope,
} from '../../../shared/properties/newStyleLocations';
import { parseStyleTagAttributes, templateFrame, type NewStyleTagSettings } from '../../../shared/properties/newStyleTag';
import { readNewStyleLocations, writeNewStyleLocations } from '../../ipc/newStyleTagBridge';
import { readStyleFiles } from '../../features/style/stylePanelBridge';
import { publishNewStyleLocations } from '../../features/style/model/newStyleTagSettings';
import { useTranslate } from '../../lib/i18n/useTranslate';
import CodeEditor from '../../ui/CodeEditor';
import { CodeIcon, FileIcon } from '../../ui/Icons';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { Skeleton } from '../../ui/Skeleton';
import { SettingsNotice, SettingsRow, SettingsSaveRow, SettingsSection, useSaveIndicator } from './SettingsLayout';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useCodeChips } from '../../features/style/codeChips/CodeChips';
import { can } from '../../../shared/properties/projectRoles';
import { styleTagLock, styleTagParts, styleTagText } from './styleTagEditor';
import './styleTagSettings.css';

/** How long typing pauses before the block is saved: one save per thought, not per key. */
const SAVE_DELAY_MS = 600;

/** The dropdown's value for "Create a style tag". Not a stylesheet path (those end in an extension), so no file collides with it. */
/** The menu gets a search box once it lists more options than this; a short list stays clean. */
export const SEARCH_OPTIONS_MIN = 6;

/** Rows the menu draws at once; the search narrows a longer list before it is counted. */
const LIST_ROWS_MAX = 500;

export const CREATE_TAG_CHOICE = '__create-style-tag__';

/**
 * The New style locations tab: its two sections, the save indicator, and the permission that
 * governs them. Where styles go is part of the project's style setup, so the breakpoints
 * permission decides who edits it (Settings.tsx accessTabOf), as it did while the section lived
 * under Breakpoints.
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
  const [locations, setLocations] = useState<NewStyleLocations>();
  // The project's stylesheets, project-relative; undefined until listed (the dropdown shows skeleton rows meanwhile).
  const [stylesheets, setStylesheets] = useState<readonly string[]>();
  const [problem, setProblem] = useState<string>();
  // The latest locations, so a debounced editor save composes with a dropdown change made since.
  const latest = useRef<NewStyleLocations | undefined>(undefined);
  // Writes run one after another, each carrying the whole latest value, so the file ends at what was chosen last.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    const failed = (failure: unknown): void => {
      if (live) {
        setProblem(translate('settings.styleTags.error.save', { message: failure instanceof Error ? failure.message : String(failure) }));
      }
    };
    readNewStyleLocations(projectPath).then((saved) => {
      if (live) {
        latest.current = saved;
        setLocations(saved);
      }
    }, failed);
    readStyleFiles(projectPath).then((listed) => {
      if (live) {
        setStylesheets(listed.ok ? stylesheetChoices(listed.value.map((file) => file.rel)) : []);
      }
    }, failed);
    return () => {
      live = false;
    };
  }, [projectPath, translate]);

  // The scope's location changes: shown and applied at once, written behind it.
  const change = (scope: NewStyleScope, update: (location: NewStyleLocation) => NewStyleLocation): void => {
    const base = latest.current;
    assert(base !== undefined, 'StyleTagSettings: a change is made after the locations are read');
    const next: NewStyleLocations = { ...base, [scope]: update(base[scope]) };
    latest.current = next;
    setLocations(next);
    publishNewStyleLocations(next);
    const written = queue.current.then(() => writeNewStyleLocations(projectPath, next));
    queue.current = written.catch(() => undefined);
    track(written).then(
      () => setProblem(undefined),
      (failure: unknown) => setProblem(translate('settings.styleTags.error.save', { message: failure instanceof Error ? failure.message : String(failure) })),
    );
  };

  if (locations === undefined) {
    return (
      <SettingsSection title={translate('settings.newStyles.page.title')}>
        <Skeleton height="96px" radius="12px" />
      </SettingsSection>
    );
  }
  return (
    <>
      {problem !== undefined && <SettingsNotice message={problem} />}
      <ScopeSection
        key={`page:${projectPath}`}
        scope="page"
        location={locations.page}
        stylesheets={stylesheets}
        editable={editable}
        onChange={(update) => change('page', update)}
      />
      <ScopeSection
        key={`component:${projectPath}`}
        scope="component"
        location={locations.component}
        stylesheets={stylesheets}
        editable={editable}
        onChange={(update) => change('component', update)}
      />
    </>
  );
}

/** The dropdown's options: "Create a style tag", then the project's stylesheets by path; a chosen file that is gone stays listed, dimmed, so the trigger names it. */
export function locationOptions(
  location: NewStyleLocation,
  stylesheets: readonly string[],
  labels: { readonly createTag: string; readonly missing: string },
): readonly DropdownOption[] {
  const options: DropdownOption[] = [{ value: CREATE_TAG_CHOICE, label: labels.createTag, pinned: true, icon: <CodeIcon size={14} /> }];
  for (const rel of stylesheets) {
    options.push({ value: rel, label: rel, icon: <FileIcon size={14} /> });
  }
  if (location.kind === 'file' && !stylesheets.includes(location.path)) {
    options.push({ value: location.path, label: location.path, hint: labels.missing, dim: true, icon: <FileIcon size={14} /> });
  }
  assert(options.length >= 1, 'locationOptions: "Create a style tag" is always offered');
  return options;
}

function ScopeSection(props: {
  readonly scope: NewStyleScope;
  readonly location: NewStyleLocation;
  readonly stylesheets: readonly string[] | undefined;
  readonly editable: boolean;
  readonly onChange: (update: (location: NewStyleLocation) => NewStyleLocation) => void;
}) {
  const { scope, location, stylesheets, editable, onChange } = props;
  const translate = useTranslate();
  const health = stylesheets === undefined ? ({ kind: 'ready' } as const) : locationHealth(location, stylesheets);
  const options = locationOptions(location, stylesheets ?? [], {
    createTag: translate('settings.newStyles.createTag'),
    missing: translate('settings.newStyles.missingHint'),
  });
  const value = location.kind === 'file' ? location.path : CREATE_TAG_CHOICE;
  const title = translate(scope === 'page' ? 'settings.newStyles.page.title' : 'settings.newStyles.component.title');
  const info = translate(scope === 'page' ? 'settings.newStyles.page.info' : 'settings.newStyles.component.info');
  return (
    <SettingsSection title={title} info={info}>
      <div className="style-tags-cards" data-scope={scope}>
        <SettingsRow label={translate('settings.newStyles.location.label')}>
          <Dropdown
            ariaLabel={`${title}: ${translate('settings.newStyles.location.label')}`}
            value={value}
            options={options}
            disabled={!editable}
            searchable={options.length > SEARCH_OPTIONS_MIN}
            rowsMax={LIST_ROWS_MAX}
            loading={stylesheets === undefined}
            menuWidthMin={320}
            onChange={(choice) => onChange((previous) => (choice === CREATE_TAG_CHOICE ? withTag(previous) : withFile(previous, choice)))}
          />
        </SettingsRow>
        {health.kind === 'missing' && (
          <span className="style-tags-chip" role="status">
            {translate('settings.newStyles.missing', { path: health.path })}
          </span>
        )}
        {/* A missing file leaves the tag in charge (the panel writes it), so its editor stays beneath the chip. */}
        {(location.kind === 'tag' || health.kind === 'missing') && (
          <TagEditor tag={location.tag} editable={editable} onChange={(tag) => onChange((previous) => withTagSettings(previous, tag))} />
        )}
      </div>
    </SettingsSection>
  );
}

// The scope's one code block: a whole `<style>` tag, as a new tag will be written, with the caption on where rules go.
function TagEditor(props: { readonly tag: NewStyleTagSettings; readonly editable: boolean; readonly onChange: (tag: NewStyleTagSettings) => void }) {
  const { tag, editable, onChange } = props;
  const translate = useTranslate();
  const [text, setText] = useState(() => styleTagText(tag));
  const [invalid, setInvalid] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Made once: the editor reads its extensions when it is made, and the lock never changes.
  // The block is a `<style>` tag: its CSS draws the same chips as every other style tag editor.
  const codeChips = useCodeChips('markup');
  const chipExtension = codeChips.extension;
  const lock = useMemo(() => [styleTagLock(), chipExtension], [chipExtension]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const edit = (next: string): void => {
    setText(next);
    clearTimeout(timer.current);
    const settings = styleTagSettingsOf(next);
    setInvalid(settings === undefined);
    if (settings !== undefined) {
      timer.current = setTimeout(() => onChange(settings), SAVE_DELAY_MS);
    }
  };
  return (
    <>
      <div className="style-tags-editor" data-readonly={editable ? undefined : ''} data-invalid={invalid ? '' : undefined}>
        <CodeEditor language="html" indentation="spaces" chrome="minimal" value={text} extensions={lock} onChange={editable ? edit : undefined} />
        {invalid && (
          <span className="style-tags-invalid" role="alert">
            {translate('settings.styleTags.invalid')}
          </span>
        )}
        {codeChips.overlay}
      </div>
    </>
  );
}
