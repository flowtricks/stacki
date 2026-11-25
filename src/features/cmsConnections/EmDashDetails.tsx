// What the EmDash dialog says about the project: the not-set-up state (a headline, with room for the install section), and for a project that uses EmDash the content types and fields as EmDash defines them, what
// is missing, where the types came from, and how to preview with a customer's real content.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { WarningTriangleIcon } from '../../ui/Icons';
import { openEmDashAdmin, readEmDashAdminUrl } from '../../ipc/emdashBridge';
import { EmDashCode } from './EmDashCode';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { EmDashBinding, EmDashCollection, EmDashProblem, EmDashProject, EmDashSchemaSource } from '../../../shared/properties/emdash';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

export type EmDashPresentProject = Extract<EmDashProject, { readonly kind: 'present' }>;
type Present = EmDashPresentProject;

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
const GUIDE_COMMANDS = {
  login: 'npx emdash login --url https://customer-site.example',
  export: 'npx emdash site export --url https://customer-site.example --output customer.emdash',
  analyze: 'npx emdash site import customer.emdash --analyze',
  import: 'npx emdash site import customer.emdash --plan <digest> --confirm',
} as const;

/** The not-set-up state. Its heading belongs to the install section, which says what state the dialog is in. */
export function EmDashAbsent({ children }: { readonly children?: ReactNode }) {
  return <>{children}</>;
}

/** One quiet line of what the project has: content types, database file, how pages are rendered. */
export function EmDashStatusLine({ project }: { readonly project: Present }) {
  const translate = useTranslate();
  return (
    <p className="emdash-status-line">
      {translate('emdash.status.line', {
        count: project.collections.length,
        database: project.databaseFile ?? '–',
        mode: translate(OUTPUT_KEYS[project.output]),
      })}
    </p>
  );
}

/** The content types as compact cards, each with its field count and its fields one disclosure away. Never editable here. */
export function EmDashCollections({ project }: { readonly project: Present }) {
  return (
    <ul className="emdash-collections">
      {project.collections.map((collection) => (
        <Collection key={collection.slug} collection={collection} />
      ))}
    </ul>
  );
}

/** Everything that is not needed at a glance: what is missing, where the types came from, the note, the customer-content guide. */
export function EmDashPresentDetails({ project }: { readonly project: Present }) {
  const translate = useTranslate();
  return (
    <>
      {project.problems.length > 0 && (
        <ul className="emdash-problems">
          {project.problems.map((problem) => (
            <li key={problem}>
              <WarningTriangleIcon size={12} />
              <span>{translate(PROBLEM_KEYS[problem])}</span>
            </li>
          ))}
        </ul>
      )}
      {project.schemaSource !== undefined && <p>{translate(SOURCE_KEYS[project.schemaSource])}</p>}
      <p>{translate('emdash.hint.definedInEmDash')}</p>
      <Guide />
    </>
  );
}

/** A project that has EmDash: the status line, the content-type cards and, when the preview runs, the button that opens its admin. */
export function EmDashPresent({ project, projectPath }: { readonly project: Present; readonly projectPath: string }) {
  const translate = useTranslate();
  return (
    <>
      <EmDashStatusLine project={project} />
      <EmDashCollections project={project} />
      <EmDashAdminButton projectPath={projectPath} label={translate('emdash.open.admin')} />
      <details className="emdash-more">
        <summary>{translate('emdash.details')}</summary>
        <div className="emdash-more-body">
          <EmDashPresentDetails project={project} />
        </div>
      </details>
    </>
  );
}

/** The primary button that opens the EmDash admin on the preview's own address; absent while no preview runs. */
export function EmDashAdminButton({
  projectPath,
  label,
  address,
}: {
  readonly projectPath: string;
  readonly label: string;
  readonly address?: string | undefined;
}) {
  const [url, setUrl] = useState<string | undefined>(address);
  useEffect(() => {
    let current = true;
    if (address === undefined) {
      readEmDashAdminUrl(projectPath).then(
        (found) => current && setUrl(found),
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [projectPath, address]);
  if (url === undefined) {
    return undefined;
  }
  return (
    <div className="emdash-actions">
      <button type="button" className="primary" onClick={() => void openEmDashAdmin(url).catch(() => undefined)}>
        {label}
      </button>
    </div>
  );
}

function Collection({ collection }: { readonly collection: EmDashCollection }) {
  const translate = useTranslate();
  return (
    <li>
      <details className="emdash-collection">
        <summary>
          {collection.label}
          <span>{translate('emdash.collection.fields', { count: collection.fields.length })}</span>
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
      <EmDashCode text={GUIDE_COMMANDS.login} language="shell" label={translate('emdash.guide.login')} />
      <p>{translate('emdash.guide.export')}</p>
      <EmDashCode text={GUIDE_COMMANDS.export} language="shell" label={translate('emdash.guide.export')} />
      <p>{translate('emdash.guide.analyze')}</p>
      <EmDashCode text={GUIDE_COMMANDS.analyze} language="shell" label={translate('emdash.guide.analyze')} />
      <p>{translate('emdash.guide.import')}</p>
      <EmDashCode text={GUIDE_COMMANDS.import} language="shell" label={translate('emdash.guide.import')} />
      <p>{translate('emdash.guide.safe')}</p>
    </details>
  );
}
