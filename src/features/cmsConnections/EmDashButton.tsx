// EmDash in Settings: a button in the CMS row, beside Payload and Custom CMS, that opens a popup with what Stacki found
// in the project (EmDash is detected from its own files, there is no key to paste), the content types and fields it
// defines, what is missing, and how to preview with a customer's real content. Content types are read from EmDash and
// only shown here; nothing in the popup edits them.
//
// Lifetime: Popup owns it. An outside press, Escape and a scroll that moves the button close it, every time; this file
// closes it for no other reason. Escape returns focus to the button. The button toggles it (a native button, so Enter
// and Space open it).
//
// Placement: below the button, flipped above when there is no room, from the button's box at open and clamped to the
// window by placeMenu. The popup scrolls inside itself (overscroll contained); the page behind never moves.
//
// Data: the project is read when the button mounts, so the connected mark shows without opening the popup and the popup
// renders what is already known at once; skeleton rows show only while that first read is still out.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CodeBlock } from '../../ui/CodeBlock';
import { EmDashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { placeMenu } from '../../ui/menuModel';
import type { MenuPosition } from '../../ui/menuModel';
import '../../ui/menu.css';
import { SkeletonRows } from '../../ui/Skeleton';
import { EMDASH_HOST, readEmDashProject } from '../../ipc/emdashBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { EmDashBinding, EmDashCollection, EmDashProblem, EmDashProject, EmDashSchemaSource } from '../../../shared/properties/emdash';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

type Present = Extract<EmDashProject, { readonly kind: 'present' }>;

const PROBLEM_KEYS: Readonly<Record<EmDashProblem, MessageKey>> = {
  databaseTracked: 'emdash.problem.databaseTracked',
  databaseUnreadable: 'emdash.problem.databaseUnreadable',
  noDatabase: 'emdash.problem.noDatabase',
  noIntegration: 'emdash.problem.noIntegration',
  noLiveCollection: 'emdash.problem.noLiveCollection',
  noSchema: 'emdash.problem.noSchema',
  notInstalled: 'emdash.problem.notInstalled',
  schemaUnreadable: 'emdash.problem.schemaUnreadable',
  staticOutput: 'emdash.problem.staticOutput',
  uploadsTracked: 'emdash.problem.uploadsTracked',
};

const BINDING_KEYS: Readonly<Record<EmDashBinding, MessageKey>> = {
  boolean: 'emdash.binding.boolean',
  data: 'emdash.binding.data',
  date: 'emdash.binding.date',
  file: 'emdash.binding.file',
  image: 'emdash.binding.image',
  link: 'emdash.binding.link',
  list: 'emdash.binding.list',
  number: 'emdash.binding.number',
  reference: 'emdash.binding.reference',
  richText: 'emdash.binding.richText',
  text: 'emdash.binding.text',
};

const SOURCE_KEYS: Readonly<Record<EmDashSchemaSource, MessageKey>> = {
  database: 'emdash.schema.database',
  'schema-json': 'emdash.schema.schemaJson',
  seed: 'emdash.schema.seed',
};

const OUTPUT_KEYS: Readonly<Record<Present['output'], MessageKey>> = {
  server: 'emdash.output.server',
  static: 'emdash.output.static',
  unknown: 'emdash.output.unknown',
};

// The commands EmDash's own CLI documents for copying a customer's site into a local one (`emdash login`,
// `emdash site export`, `emdash site import`); the person signs in with EmDash, never through Stacki.
const CREATE_COMMAND = 'npm create emdash@latest';
const GUIDE_COMMANDS = {
  login: 'npx emdash login --url https://customer-site.example',
  export: 'npx emdash site export --url https://customer-site.example --output customer.emdash',
  analyze: 'npx emdash site import customer.emdash --analyze',
  import: 'npx emdash site import customer.emdash --plan <digest> --confirm',
} as const;

const POPUP_WIDTH_PX = 360;
// Title 28 + padding 24 + three skeleton rows, before the real size is measured.
const POPUP_HEIGHT_PX_ESTIMATE = 160;

export function EmDashButton({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const [project, setProject] = useState<EmDashProject | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  useEffect(() => {
    let current = true;
    if (EMDASH_HOST.available) {
      readEmDashProject(projectPath).then(
        (found) => current && setProject(found),
        // A project that cannot be read is shown as having no EmDash: the button never blocks the other connections.
        () => current && setProject({ kind: 'absent' }),
      );
    }
    return () => {
      current = false;
    };
  }, [projectPath]);
  if (!EMDASH_HOST.available) {
    return <></>;
  }
  return (
    <>
      <button
        type="button"
        ref={(element) => setAnchor(element ?? undefined)}
        data-cms="emdash"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="cms-connect-icon">
          <EmDashIcon size={14} />
          {project?.kind === 'present' && <span className="cms-connect-status" role="img" aria-label={translate('emdash.button.connected')} />}
        </span>
        {/* i18n-ignore: EmDash is a product name. */}
        EmDash
      </button>
      <EmDashPopup open={open} anchor={anchor} project={project} onClose={() => setOpen(false)} />
    </>
  );
}

function EmDashPopup(props: {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  readonly project: EmDashProject | undefined;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
  // Measured after the content is in, so a project that arrives while the popup is open is placed by its real size.
  useLayoutEffect(() => {
    if (!props.open || props.anchor === undefined) {
      return;
    }
    const box = props.anchor.getBoundingClientRect();
    const measured = surface.current?.getBoundingClientRect();
    const size = {
      width: measured !== undefined && measured.width > 0 ? measured.width : POPUP_WIDTH_PX,
      height: measured !== undefined && measured.height > 0 ? measured.height : POPUP_HEIGHT_PX_ESTIMATE,
    };
    setPosition(
      placeMenu(
        { left: box.left, top: box.top, width: box.width, height: box.height },
        size,
        { width: window.innerWidth, height: window.innerHeight },
        'below-start',
      ),
    );
  }, [props.open, props.anchor, props.project]);
  return (
    <Popup
      mode="popover"
      open={props.open}
      anchor={props.anchor}
      onClose={props.onClose}
      ref={surface}
      className="menu-surface emdash-popup"
      role="dialog"
      label={translate('emdash.title')}
      style={{
        position: 'fixed',
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: POPUP_WIDTH_PX,
        maxHeight: position?.heightMax ?? 'calc(100dvh - 16px)',
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <h4>
        <EmDashIcon size={14} />
        {/* i18n-ignore: EmDash is a product name. */}
        EmDash
      </h4>
      {props.project === undefined && <SkeletonRows count={3} />}
      {props.project?.kind === 'absent' && <Absent />}
      {props.project?.kind === 'present' && <PresentCard project={props.project} />}
    </Popup>
  );
}

function Absent() {
  const translate = useTranslate();
  return (
    <>
      <p>
        <strong>{translate('emdash.absent.title')}</strong>
      </p>
      <p>{translate('emdash.absent.hint')}</p>
      <p>{translate('emdash.absent.create')}</p>
      <CodeBlock text={CREATE_COMMAND} language="shell" label={translate('emdash.absent.create')} />
    </>
  );
}

function PresentCard({ project }: { readonly project: Present }) {
  const translate = useTranslate();
  return (
    <>
      <dl className="emdash-facts">
        <dt>{translate('emdash.status.collections')}</dt>
        <dd>{project.collections.length}</dd>
        <dt>{translate('emdash.status.database')}</dt>
        <dd>{project.databaseFile ?? '–'}</dd>
        <dt>{translate('emdash.status.output')}</dt>
        <dd>{translate(OUTPUT_KEYS[project.output])}</dd>
      </dl>
      {project.schemaSource !== undefined && <p>{translate(SOURCE_KEYS[project.schemaSource])}</p>}
      {project.problems.length > 0 && (
        <ul className="emdash-problems">
          {project.problems.map((problem) => (
            <li key={problem}>{translate(PROBLEM_KEYS[problem])}</li>
          ))}
        </ul>
      )}
      <ul className="emdash-collections">
        {project.collections.map((collection) => (
          <Collection key={collection.slug} collection={collection} />
        ))}
      </ul>
      <p>{translate('emdash.hint.definedInEmDash')}</p>
      <Guide />
    </>
  );
}

function Collection({ collection }: { readonly collection: EmDashCollection }) {
  const translate = useTranslate();
  return (
    <li>
      <details className="emdash-collection">
        <summary>
          {collection.label}
          <span>{collection.urlPattern ?? collection.slug}</span>
        </summary>
        <ul className="emdash-fields">
          {collection.fields.map((field) => (
            <li key={field.slug} className="emdash-field">
              <span>{field.label}</span>
              <code>{field.slug}</code>
              {field.required && <span>{translate('emdash.field.required')}</span>}
              <span className="emdash-field-kind">
                {field.type === 'unsupported' ? translate('emdash.field.unsupported') : translate(BINDING_KEYS[field.binding])}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function Guide() {
  const translate = useTranslate();
  return (
    <details className="emdash-guide">
      <summary>{translate('emdash.guide.title')}</summary>
      <p>{translate('emdash.guide.login')}</p>
      <CodeBlock text={GUIDE_COMMANDS.login} language="shell" label={translate('emdash.guide.login')} />
      <p>{translate('emdash.guide.export')}</p>
      <CodeBlock text={GUIDE_COMMANDS.export} language="shell" label={translate('emdash.guide.export')} />
      <p>{translate('emdash.guide.analyze')}</p>
      <CodeBlock text={GUIDE_COMMANDS.analyze} language="shell" label={translate('emdash.guide.analyze')} />
      <p>{translate('emdash.guide.import')}</p>
      <CodeBlock text={GUIDE_COMMANDS.import} language="shell" label={translate('emdash.guide.import')} />
      <p>{translate('emdash.guide.safe')}</p>
    </details>
  );
}
