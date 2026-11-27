// The Instructions sections of the Settings panel: every Markdown file in the project, in three groups, Skills
// (named by their frontmatter), Rules and Docs (folder trees), drawn as three of the panel's sections through
// the context the frame hands them (src/lib/settingsSections.ts). Picking a file opens it in the reading view
// over the canvas (InstructionsView.tsx). "+" creates a skill scaffold, a rule or a doc; Rules also creates
// folders. A row's menu reveals or copies a file, or hides it or its folder, which writes
// `.stacki/instructions.json` (Settings → Instructions lists them). The list follows the disk: main's watcher
// and the app's own saves list it again (instructionsBridge.ts), and so do the window regaining focus and the
// panel's Refresh. The search, the folded sections and the fold-all requests are the frame's, not this file's.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { can } from '../../../shared/properties/projectRoles';
import {
  fileNameProblemDescribed,
  parseInstructionFilePath,
  ruleScaffold,
  skillNameProblemDescribed,
  skillScaffold,
  slugName,
  withHidden,
  type InstructionListing,
} from '../../../shared/properties/instructions';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { SETTINGS_SECTION_TITLE_KEYS, type SettingsSectionId, type SettingsSectionsContext } from '../../lib/settingsSections';
import { instructionsListingCache } from './instructionsListingCache';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import InfoHint from '../../ui/InfoHint';
import { type MenuItem } from '../../ui/MoreMenu';
import { FolderIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon, SkillIcon } from '../../ui/Icons';
import { PanelRow } from '../../ui/PanelRow';
import { PanelSection, PanelSectionAction, PanelSectionNote } from '../../ui/PanelSection';
import {
  announceInstructionsChanged,
  createInstruction,
  createInstructionFolder,
  listInstructions,
  onInstructionsChanged,
  readInstructionSettings,
  revealInstruction,
  writeInstructionSettings,
} from './instructionsBridge';
import {
  countFiles,
  filterSections,
  folderOf,
  folderPaths,
  ruleHomes,
  rulePath,
  sectionsOf,
  skillHome,
  skillPath,
  type SkillRow,
  type TreeNode,
} from './instructionsModel';
import { useReportMatches } from '../../lib/useReportMatches';
import { selectInstruction, useInstructionSelection } from './instructionSelection';
import './instructions.css';
import { FileTypeIcon } from '../../ui/ElementIcons';

interface Props {
  readonly projectPath: string;
  readonly context: SettingsSectionsContext;
  readonly showToast?: ((message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void) | undefined;
}

type Listing =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly listing: InstructionListing };
type Creating =
  { readonly kind: 'none' } | { readonly kind: 'skill' } | { readonly kind: 'rule' } | { readonly kind: 'rule-folder' } | { readonly kind: 'doc' };

export default function InstructionsSections({ projectPath, context, showToast }: Props) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const editable = can(role, 'instructions:edit');
  const listing = useListing(projectPath);
  const selected = useInstructionSelection(projectPath);
  const [creating, setCreating] = useState<Creating>({ kind: 'none' });
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  const { query, searching } = context;
  const report = useCallback((message: string) => showToast?.(message, 'error'), [showToast]);
  const allSections = useMemo(() => (listing.state.kind === 'ready' ? sectionsOf(listing.state.listing) : undefined), [listing.state]);
  // Searched, only the matches are drawn, every section and folder with one open; what the person folded is kept and returns when the search clears.
  const sections = useMemo(() => (allSections !== undefined && searching ? filterSections(allSections, query) : allSections), [allSections, searching, query]);
  const shownFolders = useMemo(
    () => (sections === undefined || !searching ? undefined : new Set([...folderPaths(sections.rules), ...folderPaths(sections.docs)])),
    [sections, searching],
  );
  const allFolders = useMemo(() => (allSections === undefined ? [] : [...folderPaths(allSections.rules), ...folderPaths(allSections.docs)]), [allSections]);

  // The frame's fold-all and Refresh reach the folders and the listing, which only this file knows.
  const folders = useRef(allFolders);
  folders.current = allFolders;
  const { bulk, refreshSerial } = context;
  useEffect(() => {
    if (bulk.mode === 'expand') {
      setOpenFolders(new Set(folders.current));
    } else if (bulk.mode === 'collapse') {
      setOpenFolders(new Set());
    }
  }, [bulk]);
  const { refresh } = listing;
  useEffect(() => {
    if (refreshSerial > 0) {
      refresh();
    }
  }, [refreshSerial, refresh]);
  const skillCount = sections?.skills.length;
  const ruleCount = sections === undefined ? undefined : countFiles(sections.rules);
  const documentCount = sections === undefined ? undefined : countFiles(sections.docs);
  // What each group holds is told to the frame, which says so when a search finds nothing in any section.
  useReportMatches(context, 'skills', skillCount);
  useReportMatches(context, 'rules', ruleCount);
  useReportMatches(context, 'docs', documentCount);

  const open = (file: string): void => selectInstruction({ projectPath, file });
  const hide = async (pattern: string): Promise<void> => {
    try {
      const stored = await readInstructionSettings(projectPath);
      const next = withHidden(stored.settings, pattern);
      if (!next.ok) {
        report(next.error);
        return;
      }
      await writeInstructionSettings(projectPath, next.value, stored.source);
      if (selected !== undefined && (selected === pattern || selected.startsWith(`${pattern}/`))) {
        selectInstruction(undefined);
      }
      showToast?.(translate('instructionsPanel.hidden', { pattern }), 'success');
    } catch (failure: unknown) {
      report(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const menuFor = (path: string, options: { readonly folder: boolean }): readonly MenuItem[] => {
    const parent = options.folder ? path : folderOf(path);
    return [
      { label: translate('instructionsPanel.menu.reveal'), onSelect: () => void revealInstruction(projectPath, path) },
      { label: translate('instructionsPanel.menu.copyPath'), onSelect: () => void navigator.clipboard.writeText(path) },
      ...(editable && !options.folder ? [{ label: translate('instructionsPanel.menu.hideFile'), onSelect: () => void hide(path) }] : []),
      ...(editable && parent !== undefined ? [{ label: translate('instructionsPanel.menu.hideFolder'), onSelect: () => void hide(parent) }] : []),
    ];
  };
  const toggleFolder = (folder: string): void =>
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  const created = (file: string | undefined): void => {
    setCreating({ kind: 'none' });
    listing.refresh();
    if (file !== undefined) {
      open(file);
    }
  };
  const startCreating = (next: Exclude<Creating, { readonly kind: 'none' }>, section: SettingsSectionId): void => {
    // A new file's form lives in its section, which a search or a fold may be hiding.
    context.clearSearch();
    setCreating(next);
    context.open(section);
  };

  if (listing.state.kind === 'error') {
    // The failure is a toast; the panel keeps its empty body, so nothing is appended.
    return <ErrorToast message={listing.state.message} />;
  }
  if (listing.state.kind === 'loading' || sections === undefined) {
    // Nothing is listed yet: no sections and no word, so the panel does not move when the rows arrive.
    return undefined;
  }
  const { listing: ready } = listing.state;
  return (
    <>
      {!(searching && sections.skills.length === 0) && (
        <PanelSection
          id="skills"
          title={translate(SETTINGS_SECTION_TITLE_KEYS.skills)}
          count={sections.skills.length}
          open={context.isOpen('skills')}
          onToggle={() => context.toggle('skills')}
          actions={
            editable && (
              <PanelSectionAction
                label={translate('instructionsPanel.skills.new')}
                icon={<PlusIcon size={13} />}
                onClick={() => startCreating({ kind: 'skill' }, 'skills')}
              />
            )
          }
        >
          {creating.kind === 'skill' && <SkillForm home={skillHome(ready)} projectPath={projectPath} onDone={created} onError={report} />}
          {sections.skills.length === 0 && creating.kind !== 'skill' && <PanelSectionNote>{translate('instructionsPanel.skills.empty')}</PanelSectionNote>}
          {sections.skills.map((skill) => (
            <SkillItem key={skill.path} skill={skill} selected={selected === skill.path} onOpen={open} menu={menuFor(skill.path, { folder: false })} />
          ))}
        </PanelSection>
      )}
      {!(searching && countFiles(sections.rules) === 0) && (
        <PanelSection
          id="rules"
          title={translate(SETTINGS_SECTION_TITLE_KEYS.rules)}
          count={countFiles(sections.rules)}
          open={context.isOpen('rules')}
          onToggle={() => context.toggle('rules')}
          actions={
            editable && (
              <>
                <PanelSectionAction
                  label={translate('instructionsPanel.rules.newFolder')}
                  icon={<FolderPlusIcon size={13} />}
                  onClick={() => startCreating({ kind: 'rule-folder' }, 'rules')}
                />
                <PanelSectionAction
                  label={translate('instructionsPanel.rules.new')}
                  icon={<PlusIcon size={13} />}
                  onClick={() => startCreating({ kind: 'rule' }, 'rules')}
                />
              </>
            )
          }
        >
          {(creating.kind === 'rule' || creating.kind === 'rule-folder') && (
            <RuleForm kind={creating.kind} homes={ruleHomes(ready)} projectPath={projectPath} onDone={created} onError={report} />
          )}
          {sections.rules.length === 0 && creating.kind !== 'rule' && creating.kind !== 'rule-folder' && (
            <PanelSectionNote>{translate('instructionsPanel.rules.empty')}</PanelSectionNote>
          )}
          <Tree
            nodes={sections.rules}
            depth={0}
            openFolders={shownFolders ?? openFolders}
            selected={selected}
            onToggle={toggleFolder}
            onOpen={open}
            menuFor={menuFor}
          />
        </PanelSection>
      )}
      {!(searching && countFiles(sections.docs) === 0) && (
        <PanelSection
          id="docs"
          title={translate(SETTINGS_SECTION_TITLE_KEYS.docs)}
          count={countFiles(sections.docs)}
          open={context.isOpen('docs')}
          onToggle={() => context.toggle('docs')}
          actions={
            editable && (
              <PanelSectionAction
                label={translate('instructionsPanel.docs.new')}
                icon={<PlusIcon size={13} />}
                onClick={() => startCreating({ kind: 'doc' }, 'docs')}
              />
            )
          }
        >
          {creating.kind === 'doc' && <DocumentForm projectPath={projectPath} onDone={created} onError={report} />}
          {sections.docs.length === 0 && creating.kind !== 'doc' && <PanelSectionNote>{translate('instructionsPanel.docs.empty')}</PanelSectionNote>}
          <Tree
            nodes={sections.docs}
            depth={0}
            openFolders={shownFolders ?? openFolders}
            selected={selected}
            onToggle={toggleFolder}
            onOpen={open}
            menuFor={menuFor}
          />
        </PanelSection>
      )}
      {ready.truncated && <PanelSectionNote>{translate('instructionsPanel.truncated')}</PanelSectionNote>}
    </>
  );
}

// The listing, read on mount and again on every change main or the app announces, and on focus.
function useListing(projectPath: string) {
  // The kept listing draws in the first frame; the read below refreshes it in place.
  const [state, setState] = useState<Listing>(() => keptListing(projectPath));
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((count) => count + 1), []);
  useEffect(() => {
    let active = true;
    void listInstructions(projectPath).then(
      (listing) => {
        instructionsListingCache.set(projectPath, listing);
        if (active) {
          setState({ kind: 'ready', listing });
        }
      },
      (failure: unknown) => {
        if (active) {
          setState({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [projectPath, tick]);
  useEffect(() => onInstructionsChanged(() => refresh()), [refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  return { state, refresh };
}

function keptListing(projectPath: string): Listing {
  const kept = instructionsListingCache.get(projectPath);
  if (kept?.kind === 'ready') {
    return { kind: 'ready', listing: kept.value };
  }
  return { kind: 'loading' };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function SkillItem(props: {
  readonly skill: SkillRow;
  readonly selected: boolean;
  readonly menu: readonly MenuItem[];
  readonly onOpen: (file: string) => void;
}) {
  const { skill } = props;
  // The description is the row's tooltip only: the sidebar stays one line per skill.
  return (
    <PanelRow
      depth={0}
      label={skill.name}
      icon={<SkillIcon size={13} />}
      title={`${skill.description}\n${skill.path}`}
      selected={props.selected}
      folder={undefined}
      menu={props.menu}
      onActivate={() => props.onOpen(skill.path)}
    />
  );
}

function Tree(props: {
  readonly nodes: readonly TreeNode[];
  readonly depth: number;
  readonly openFolders: ReadonlySet<string>;
  readonly selected: string | undefined;
  readonly onToggle: (folder: string) => void;
  readonly onOpen: (file: string) => void;
  readonly menuFor: (path: string, options: { readonly folder: boolean }) => readonly MenuItem[];
}) {
  assert(props.depth <= 32, 'The tree is no deeper than the walk');
  return (
    <>
      {props.nodes.map((node) => {
        if (node.kind === 'file') {
          return (
            <PanelRow
              key={node.path}
              depth={props.depth}
              label={node.label}
              icon={<FileTypeIcon name={node.path} size={13} />}
              title={node.path}
              selected={props.selected === node.path}
              folder={undefined}
              menu={props.menuFor(node.path, { folder: false })}
              onActivate={() => props.onOpen(node.path)}
            />
          );
        }
        const open = props.openFolders.has(node.path);
        return (
          <div key={node.path} role="group">
            <PanelRow
              depth={props.depth}
              label={node.label}
              icon={open ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />}
              title={node.path}
              selected={false}
              folder={{ open }}
              menu={props.menuFor(node.path, { folder: true })}
              onActivate={() => props.onToggle(node.path)}
            />
            {open && <Tree {...props} nodes={node.children} depth={props.depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Create forms
// ---------------------------------------------------------------------------

interface FormProps {
  readonly projectPath: string;
  readonly onDone: (file: string | undefined) => void;
  readonly onError: (message: string) => void;
}

function SkillForm(props: FormProps & { readonly home: string }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string>();
  const submit = async (): Promise<void> => {
    const slug = slugName(name);
    const nameProblem = skillNameProblemDescribed(slug);
    if (nameProblem !== undefined) {
      setProblem(translateDescribed(nameProblem));
      return;
    }
    if (description.trim() === '') {
      setProblem(translate('instructionsPanel.form.skillNeedsWhen'));
      return;
    }
    const file = skillPath(props.home, slug);
    const result = await createInstruction(props.projectPath, file, skillScaffold(slug, description));
    if (result.ok) {
      announceInstructionsChanged([file]);
      props.onDone(file);
    } else {
      setProblem(result.error.message);
    }
  };
  return (
    <CreateForm
      label={translate('instructionsPanel.skills.new')}
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input
        type="text"
        aria-label={translate('instructionsPanel.form.skillName')}
        placeholder="skill-name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <textarea
        aria-label={translate('instructionsPanel.form.skillDescription')}
        placeholder={translate('instructionsPanel.form.skillPlaceholder')}
        rows={3}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <InfoHint text={translate('instructionsPanel.form.savedAs', { path: `${props.home}/${slugName(name) || 'skill-name'}/SKILL.md` })} />
    </CreateForm>
  );
}

const ROOT_FOLDER = '';

function RuleForm(props: FormProps & { readonly kind: 'rule' | 'rule-folder'; readonly homes: readonly string[] }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(props.homes[0] ?? ROOT_FOLDER);
  const [problem, setProblem] = useState<string>();
  const folderOptions = [
    ...(props.kind === 'rule' ? [{ value: ROOT_FOLDER, label: translate('instructionsPanel.form.projectRoot') }] : []),
    ...props.homes.map((home) => ({ value: home, label: home })),
  ];
  const submit = async (): Promise<void> => {
    const nameProblem = fileNameProblemDescribed(name);
    if (nameProblem !== undefined) {
      setProblem(translateDescribed(nameProblem));
      return;
    }
    if (props.kind === 'rule-folder') {
      const path = folder === ROOT_FOLDER ? name.trim() : `${folder}/${name.trim()}`;
      const result = await createInstructionFolder(props.projectPath, path);
      if (result.ok) {
        announceInstructionsChanged([]);
        props.onDone(undefined);
      } else {
        setProblem(result.error.message);
      }
      return;
    }
    const file = rulePath(folder, name);
    const result = await createInstruction(props.projectPath, file, ruleScaffold(name.trim().replace(/\.mdc?$/i, '')));
    if (result.ok) {
      announceInstructionsChanged([file]);
      props.onDone(file);
    } else {
      setProblem(result.error.message);
    }
  };
  return (
    <CreateForm
      label={props.kind === 'rule' ? translate('instructionsPanel.rules.new') : translate('instructionsPanel.rules.newFolder')}
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input
        type="text"
        aria-label={props.kind === 'rule' ? translate('instructionsPanel.form.ruleName') : translate('instructionsPanel.form.folderName')}
        placeholder={props.kind === 'rule' ? 'testing.md' : 'frontend'}
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Dropdown ariaLabel={translate('instructionsPanel.form.folder')} value={folder} options={folderOptions} onChange={setFolder} />
    </CreateForm>
  );
}

function DocumentForm(props: FormProps) {
  const translate = useTranslate();
  const [path, setPath] = useState('docs/');
  const [problem, setProblem] = useState<string>();
  const submit = async (): Promise<void> => {
    let file: string;
    try {
      file = parseInstructionFilePath(/\.md$/i.test(path.trim()) ? path.trim() : `${path.trim()}.md`);
    } catch (failure: unknown) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    const title = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const result = await createInstruction(props.projectPath, file, ruleScaffold(title));
    if (result.ok) {
      announceInstructionsChanged([file]);
      props.onDone(file);
    } else {
      setProblem(result.error.message);
    }
  };
  return (
    <CreateForm
      label={translate('instructionsPanel.docs.new')}
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input
        type="text"
        aria-label={translate('instructionsPanel.form.docPath')}
        placeholder="docs/guide.md"
        autoFocus
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
    </CreateForm>
  );
}

function CreateForm(props: {
  readonly label: string;
  readonly problem: string | undefined;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly children: ReactNode;
}) {
  const translate = useTranslate();
  return (
    <form
      className="instructions-form"
      aria-label={props.label}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          props.onCancel();
        }
      }}
    >
      {props.children}
      <ErrorToast message={props.problem} />
      <div className="instructions-form-actions">
        <button type="button" onClick={props.onCancel}>
          {translate('ui.cancel')}
        </button>
        <button type="submit" className="primary">
          {translate('instructionsPanel.form.create')}
        </button>
      </div>
    </form>
  );
}
