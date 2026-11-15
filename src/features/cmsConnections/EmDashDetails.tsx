// What the EmDash dialog says about the project: the not-set-up state (a headline, with room for the install section), and for a project that uses EmDash the content types and fields as EmDash defines them, what
// is missing, where the types came from, and how to preview with a customer's real content.
import type { ReactNode } from 'react';
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

export function EmDashAbsent({ children }: { readonly children?: ReactNode }) {
  const translate = useTranslate();
  return (
    <>
      <p>
        <strong>{translate('emdash.absent.title')}</strong>
      </p>
      {children}
    </>
  );
}

export function EmDashPresent({ project }: { readonly project: Present }) {
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
