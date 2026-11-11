// The open instructions file as a CMS entry: the Instructions feature's view
// (header, saving, conflicts, Source) with the CMS's own fields for its form, so
// a skill's name and description edit exactly as a CMS entry's fields do, and
// its body is the CMS's rich text field. Composed here, in the app layer,
// because one feature does not import another (eslint `stacki/source-layers`).
//
// Each frontmatter key is one field, chosen by what its YAML reads as: text
// (`description` as a multiline box), a number, an on/off switch or a date.
// Every edit splices that key's one line (frontmatterFields.ts), so the rest of
// the file keeps its bytes; text is still written as one YAML line, wrapped only
// on screen. Frontmatter that is not flat `key: value` lines is one YAML field.
import { splitFrontmatter } from '../../../shared/properties/instructions';
import { CmsFieldFrame, CmsPropField } from '../../features/cms/CmsPropField';
import '../../features/cms/remoteCms.css';
import { frontmatterView, withFieldValue, withFrontmatterYaml, type FrontmatterField } from '../../features/instructions/frontmatterFields';
import InstructionsView, { ReadOnlyBody, type InstructionFormProps, type InstructionsViewProps } from '../../features/instructions/InstructionsView';
import { CodeBlock } from '../../ui/CodeBlock';
import CodeEditor from '../../ui/CodeEditor';
import DateField from '../../ui/DateField';
import { BracesIcon, CalendarIcon } from '../../ui/Icons';
import MarkdownField from '../../ui/MarkdownField';

export default function InstructionsDocument(props: InstructionsViewProps) {
  return <InstructionsView {...props} Form={InstructionForm} />;
}

/** Keys whose text is prose: a multiline box, as a CMS long text is. */
const PROSE_KEYS: ReadonlySet<string> = new Set(['description', 'summary', 'excerpt', 'when_to_use', 'instructions']);

export function InstructionForm({ source, editable, onChange }: InstructionFormProps) {
  const split = splitFrontmatter(source);
  const view = frontmatterView(source);
  return (
    // A form that cannot be edited is out of reach of the pointer and the keyboard, as a held CMS entry is.
    <div className="remote-cms-fields" {...(editable ? {} : { inert: '' })}>
      {view.kind === 'fields' &&
        view.fields.map((field) => (
          <FrontmatterInput key={`${field.line}:${field.key}`} field={field} onChange={(value) => onChange(withFieldValue(source, field, { value }))} />
        ))}
      {view.kind === 'text' && (
        <CmsFieldFrame name="Frontmatter" help="YAML that is not a flat list of fields, edited as written." icon={<BracesIcon size={12} />} set>
          {editable ? (
            <div className="html-source">
              <CodeEditor language="markdown" value={view.yaml} onChange={(yaml: string) => onChange(withFrontmatterYaml(source, yaml))} />
            </div>
          ) : (
            <CodeBlock text={view.yaml} language="markdown" label="Frontmatter" />
          )}
        </CmsFieldFrame>
      )}
      {/* The body needs no label: it is the document itself, under its fields. */}
      <div className="props-field instructions-body">
        {editable ? (
          <MarkdownField value={split.body} label="Body" extensions="gfm" onChange={(body) => onChange(split.raw + body)} />
        ) : (
          <ReadOnlyBody body={split.body} />
        )}
      </div>
    </div>
  );
}

function FrontmatterInput(props: { readonly field: FrontmatterField; readonly onChange: (value: string | number | boolean) => void }) {
  const { field } = props;
  switch (field.kind) {
    case 'date':
      return (
        <CmsFieldFrame name={field.key} help="" icon={<CalendarIcon size={12} />} set={field.value !== ''}>
          <DateField value={field.value} label={field.key} onChange={props.onChange} />
        </CmsFieldFrame>
      );
    case 'boolean':
      return (
        <CmsPropField
          name={field.key}
          help=""
          kind="boolean"
          options={[]}
          value={field.value === 'true'}
          onChange={(value) => props.onChange(value === true)}
        />
      );
    case 'number':
      return (
        <CmsPropField
          name={field.key}
          help=""
          kind="number"
          options={[]}
          value={Number(field.value)}
          onChange={(value) => props.onChange(typeof value === 'number' ? value : 0)}
        />
      );
    case 'string':
      return (
        <CmsPropField
          name={field.key}
          help=""
          kind={PROSE_KEYS.has(field.key.toLowerCase()) ? 'text' : 'string'}
          options={[]}
          value={field.value}
          onChange={(value) => props.onChange(value === undefined ? '' : String(value))}
        />
      );
    default: {
      const exhaustive: never = field.kind;
      return exhaustive;
    }
  }
}
