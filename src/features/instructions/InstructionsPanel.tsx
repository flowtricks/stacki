// The Instructions rail panel: every Markdown file in the project, in three
// sections — Skills (named by their frontmatter), Rules and Docs (folder trees).
// Picking a file opens it in the reading view over the canvas
// (InstructionsView.tsx). "+" creates a skill scaffold, a rule or a doc; Rules
// also creates folders. A row's menu reveals or copies a file, or hides it or its
// folder, which writes `.stacki/instructions.json` (Settings → Instructions lists
// them). The list follows the disk: main's watcher and the app's own saves list
// it again (instructionsBridge.ts), and so does the window regaining focus.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { can } from '../../../shared/properties/projectRoles';
import {
  fileNameProblem,
  parseInstructionFilePath,
  ruleScaffold,
  skillNameProblem,
  skillScaffold,
  slugName,
  withHidden,
  type InstructionListing,
} from '../../../shared/properties/instructions';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { instructionsListingCache } from './instructionsListingCache';
import Dropdown from '../../ui/Dropdown';
import MoreMenu, { type MenuItem } from '../../ui/MoreMenu';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseVerticalIcon,
  ExpandVerticalIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  InstructionsIcon,
  PlusIcon,
  SkillIcon,
} from '../../ui/Icons';
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
import { countFiles, folderOf, folderPaths, ruleHomes, rulePath, sectionsOf, skillHome, skillPath, type SkillRow, type TreeNode } from './instructionsModel';
import { selectInstruction, useInstructionSelection } from './instructionSelection';
import './instructions.css';

interface Props {
  readonly projectPath: string;
  readonly showToast?: ((message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void) | undefined;
}

type Listing =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly listing: InstructionListing };
type Creating =
  { readonly kind: 'none' } | { readonly kind: 'skill' } | { readonly kind: 'rule' } | { readonly kind: 'rule-folder' } | { readonly kind: 'doc' };
type SectionId = 'skills' | 'rules' | 'docs';

export default function InstructionsPanel({ projectPath, showToast }: Props) {
  const role = useCurrentRole();
  const editable = can(role, 'instructions:edit');
  const listing = useListing(projectPath);
  const selected = useInstructionSelection(projectPath);
  const [creating, setCreating] = useState<Creating>({ kind: 'none' });
  const [closedSections, setClosedSections] = useState<ReadonlySet<SectionId>>(new Set());
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((message: string) => showToast?.(message, 'error'), [showToast]);
  const sections = useMemo(() => (listing.state.kind === 'ready' ? sectionsOf(listing.state.listing) : undefined), [listing.state]);
  const allFolders = useMemo(() => (sections === undefined ? [] : [...folderPaths(sections.rules), ...folderPaths(sections.docs)]), [sections]);
  const expanded = closedSections.size === 0 && allFolders.every((folder) => openFolders.has(folder));

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
      showToast?.(`Hidden ${pattern}. Settings → Instructions shows it again.`, 'success');
    } catch (failure: unknown) {
      report(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const menuFor = (path: string, options: { readonly folder: boolean }): readonly MenuItem[] => {
    const parent = options.folder ? path : folderOf(path);
    return [
      { label: 'Reveal in Finder', onSelect: () => void revealInstruction(projectPath, path) },
      { label: 'Copy path', onSelect: () => void navigator.clipboard.writeText(path) },
      ...(editable && !options.folder ? [{ label: 'Hide file', onSelect: () => void hide(path) }] : []),
      ...(editable && parent !== undefined ? [{ label: 'Hide folder', onSelect: () => void hide(parent) }] : []),
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
  const toggleSection = (section: SectionId): void =>
    setClosedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
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
  const expandAll = (): void => {
    setOpenFolders(new Set(allFolders));
    setClosedSections(new Set());
  };
  const collapseAll = (): void => {
    setOpenFolders(new Set());
    setClosedSections(new Set(['skills', 'rules', 'docs']));
  };
  const startCreating = (next: Exclude<Creating, { readonly kind: 'none' }>, section: SectionId): void => {
    setCreating(next);
    setClosedSections((current) => new Set([...current].filter((each) => each !== section)));
  };

  return (
    <div className="panel-section grow instructions-panel">
      <div className="panel-header">
        <h2>Instructions</h2>
        <div className="instructions-header-actions">
          <button
            type="button"
            className="ghost"
            title={expanded ? 'Collapse all' : 'Expand all'}
            aria-label={expanded ? 'Collapse all' : 'Expand all'}
            onClick={() => (expanded ? collapseAll() : expandAll())}
          >
            {expanded ? <CollapseVerticalIcon size={13} /> : <ExpandVerticalIcon size={13} />}
          </button>
          <MoreMenu
            className="ghost"
            title="Instructions options"
            width={170}
            items={[
              { label: 'Expand all', onSelect: expandAll },
              { label: 'Collapse all', onSelect: collapseAll },
              { label: 'Refresh', onSelect: listing.refresh },
            ]}
          />
        </div>
      </div>
      <div className="panel-body instructions-body">
        {listing.state.kind === 'loading' && <div className="props-empty">Reading the project…</div>}
        {listing.state.kind === 'error' && (
          <div className="props-empty" role="alert">
            {listing.state.message}
          </div>
        )}
        {listing.state.kind === 'ready' && sections !== undefined && (
          <>
            <Section
              id="skills"
              title="Skills"
              count={sections.skills.length}
              open={!closedSections.has('skills')}
              onToggle={toggleSection}
              actions={editable && <IconButton label="New skill" icon={<PlusIcon size={13} />} onClick={() => startCreating({ kind: 'skill' }, 'skills')} />}
            >
              {creating.kind === 'skill' && <SkillForm home={skillHome(listing.state.listing)} projectPath={projectPath} onDone={created} onError={report} />}
              {sections.skills.length === 0 && creating.kind !== 'skill' && (
                <div className="instructions-empty">No skills yet. Create your first skill to give AI the context it needs to do its best work.</div>
              )}
              {sections.skills.map((skill) => (
                <SkillItem key={skill.path} skill={skill} selected={selected === skill.path} onOpen={open} menu={menuFor(skill.path, { folder: false })} />
              ))}
            </Section>
            <Section
              id="rules"
              title="Rules"
              count={countFiles(sections.rules)}
              open={!closedSections.has('rules')}
              onToggle={toggleSection}
              actions={
                editable && (
                  <>
                    <IconButton label="New rule folder" icon={<FolderPlusIcon size={13} />} onClick={() => startCreating({ kind: 'rule-folder' }, 'rules')} />
                    <IconButton label="New rule" icon={<PlusIcon size={13} />} onClick={() => startCreating({ kind: 'rule' }, 'rules')} />
                  </>
                )
              }
            >
              {(creating.kind === 'rule' || creating.kind === 'rule-folder') && (
                <RuleForm kind={creating.kind} homes={ruleHomes(listing.state.listing)} projectPath={projectPath} onDone={created} onError={report} />
              )}
              {sections.rules.length === 0 && creating.kind !== 'rule' && creating.kind !== 'rule-folder' && (
                <div className="instructions-empty">No rules yet. Add an AGENTS.md or a rule file to tell AI how this project is built.</div>
              )}
              <Tree nodes={sections.rules} depth={0} openFolders={openFolders} selected={selected} onToggle={toggleFolder} onOpen={open} menuFor={menuFor} />
            </Section>
            <Section
              id="docs"
              title="Docs"
              count={countFiles(sections.docs)}
              open={!closedSections.has('docs')}
              onToggle={toggleSection}
              actions={editable && <IconButton label="New doc" icon={<PlusIcon size={13} />} onClick={() => startCreating({ kind: 'doc' }, 'docs')} />}
            >
              {creating.kind === 'doc' && <DocumentForm projectPath={projectPath} onDone={created} onError={report} />}
              {sections.docs.length === 0 && creating.kind !== 'doc' && <div className="instructions-empty">No other Markdown files in this project.</div>}
              <Tree nodes={sections.docs} depth={0} openFolders={openFolders} selected={selected} onToggle={toggleFolder} onOpen={open} menuFor={menuFor} />
            </Section>
            {listing.state.listing.truncated && (
              <div className="instructions-empty">
                This project has more Markdown than the panel lists. Hide folders in Settings → Instructions to see the rest.
              </div>
            )}
          </>
        )}
      </div>
    </div>
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

function Section(props: {
  readonly id: SectionId;
  readonly title: string;
  readonly count: number;
  readonly open: boolean;
  readonly actions: ReactNode;
  readonly onToggle: (id: SectionId) => void;
  readonly children: ReactNode;
}) {
  return (
    <section className="instructions-section" aria-label={props.title}>
      <div className="instructions-section-head">
        <button type="button" className="instructions-section-toggle" aria-expanded={props.open} onClick={() => props.onToggle(props.id)}>
          <span className="instructions-chevron">{props.open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}</span>
          <span className="instructions-section-title">{props.title}</span>
          {props.count > 0 && <span className="instructions-section-count">{props.count}</span>}
        </button>
        <div className="instructions-section-actions">{props.actions}</div>
      </div>
      {props.open && (
        <div className="instructions-section-body" role="tree" aria-label={props.title}>
          {props.children}
        </div>
      )}
    </section>
  );
}

function IconButton(props: { readonly label: string; readonly icon: ReactNode; readonly onClick: () => void }) {
  return (
    <button type="button" className="ghost" title={props.label} aria-label={props.label} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

/** One row's left inset: the panel's 8px, then 14px per level, as the Pages tree indents. */
function indentOf(depth: number): { readonly paddingLeft: number } {
  return { paddingLeft: 8 + depth * 14 };
}

// The Pages tree's row (`.list-item`): a chevron column (empty for a file) keeps every icon on one line per depth.
function Row(props: {
  readonly depth: number;
  readonly label: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly selected: boolean;
  readonly folder: { readonly open: boolean } | undefined;
  readonly menu: readonly MenuItem[];
  readonly detail?: ReactNode;
  readonly onActivate: () => void;
}) {
  return (
    <div
      className={`list-item instructions-row ${props.folder === undefined ? '' : 'folder'} ${props.selected ? 'active' : ''}`}
      style={indentOf(props.depth)}
      role="treeitem"
      tabIndex={0}
      title={props.title}
      aria-selected={props.selected}
      aria-expanded={props.folder?.open}
      onClick={props.onActivate}
      onKeyDown={(event) => {
        // Keys on the row's own menu button are the menu's.
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onActivate();
        }
      }}
    >
      <span className="instructions-chevron">
        {props.folder === undefined ? undefined : props.folder.open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
      </span>
      <span className="icon">{props.icon}</span>
      <span className="instructions-row-copy">
        <span className="label instructions-row-label">{props.label}</span>
        {props.detail}
      </span>
      <MoreMenu className="row-action rename-action" title={`${props.label} options`} items={props.menu} width={170} />
    </div>
  );
}

function SkillItem(props: {
  readonly skill: SkillRow;
  readonly selected: boolean;
  readonly menu: readonly MenuItem[];
  readonly onOpen: (file: string) => void;
}) {
  const { skill } = props;
  // The description is the row's tooltip only: the sidebar stays one line per skill.
  return (
    <Row
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
            <Row
              key={node.path}
              depth={props.depth}
              label={node.label}
              icon={<FileIcon size={13} />}
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
            <Row
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string>();
  const submit = async (): Promise<void> => {
    const slug = slugName(name);
    const nameProblem = skillNameProblem(slug);
    if (nameProblem !== undefined) {
      setProblem(nameProblem);
      return;
    }
    if (description.trim() === '') {
      setProblem('Say when an agent should use this skill.');
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
      label="New skill"
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input type="text" aria-label="Skill name" placeholder="skill-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      <textarea
        aria-label="Skill description"
        placeholder="What it does, and when an agent should use it"
        rows={3}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <span className="instructions-form-hint">
        Saved as {props.home}/{slugName(name) || 'skill-name'}/SKILL.md
      </span>
    </CreateForm>
  );
}

const ROOT_FOLDER = '';

function RuleForm(props: FormProps & { readonly kind: 'rule' | 'rule-folder'; readonly homes: readonly string[] }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(props.homes[0] ?? ROOT_FOLDER);
  const [problem, setProblem] = useState<string>();
  const folderOptions = [
    ...(props.kind === 'rule' ? [{ value: ROOT_FOLDER, label: 'Project root' }] : []),
    ...props.homes.map((home) => ({ value: home, label: home })),
  ];
  const submit = async (): Promise<void> => {
    const nameProblem = fileNameProblem(name);
    if (nameProblem !== undefined) {
      setProblem(nameProblem);
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
      label={props.kind === 'rule' ? 'New rule' : 'New rule folder'}
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input
        type="text"
        aria-label={props.kind === 'rule' ? 'Rule name' : 'Folder name'}
        placeholder={props.kind === 'rule' ? 'testing.md' : 'frontend'}
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Dropdown ariaLabel="Folder" value={folder} options={folderOptions} onChange={setFolder} />
    </CreateForm>
  );
}

function DocumentForm(props: FormProps) {
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
      label="New doc"
      problem={problem}
      onSubmit={() => void submit().catch((failure: unknown) => props.onError(String(failure)))}
      onCancel={() => props.onDone(undefined)}
    >
      <input type="text" aria-label="Doc path" placeholder="docs/guide.md" autoFocus value={path} onChange={(event) => setPath(event.target.value)} />
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
      {props.problem !== undefined && (
        <span className="instructions-form-problem" role="alert">
          {props.problem}
        </span>
      )}
      <div className="instructions-form-actions">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Create
        </button>
      </div>
    </form>
  );
}

/** The panel's icon, for hosts that draw it outside the rail. */
export function InstructionsPanelIcon(props: { readonly size: number }) {
  return <InstructionsIcon size={props.size} />;
}
