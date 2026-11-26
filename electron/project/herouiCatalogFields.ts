import type { HeroUICatalogEntry } from './herouiCatalogTypes';

const ID_IMPORT = 'import { useId } from "react";';
const STATE_IMPORT = 'import { useState } from "react";';
const FIELD_VARIANTS = ['primary', 'secondary'] as const;

export const HEROUI_FIELDS: readonly HeroUICatalogEntry[] = [
  {
    slug: 'checkbox',
    name: 'Checkbox',
    category: 'Forms',
    imports: ['Checkbox', 'Description'],
    props: { label: 'Keep me signed in', defaultSelected: false, variant: FIELD_VARIANTS },
    slots: { hint: 'Only use this on a device you trust.' },
    hydrate: true,
    markup: `<Checkbox defaultSelected={defaultSelected} variant={variant}>
      <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{label}</Checkbox.Content>
      <Description>{hint}</Description>
    </Checkbox>`,
  },
  {
    slug: 'checkbox-group',
    name: 'CheckboxGroup',
    category: 'Forms',
    imports: ['Checkbox', 'CheckboxGroup', 'Description', 'Label'],
    props: { label: 'Notifications', firstOption: 'Product updates', secondOption: 'Weekly summary', initialSelection: ['updates', 'summary'] },
    slots: { hint: 'Choose the emails you want to receive.' },
    hydrate: true,
    markup: `<CheckboxGroup name="notifications" defaultValue={[initialSelection]}>
      <Label>{label}</Label><Description>{hint}</Description>
      <Checkbox value="updates"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{firstOption}</Checkbox.Content></Checkbox>
      <Checkbox value="summary"><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{secondOption}</Checkbox.Content></Checkbox>
    </CheckboxGroup>`,
  },
  {
    slug: 'description',
    name: 'Description',
    category: 'Forms',
    imports: ['Description', 'Input', 'Label', 'TextField'],
    props: { label: 'Display name', defaultValue: 'Jules' },
    slots: { hint: 'This name appears beside your comments.' },
    hydrate: true,
    markup: `<TextField className="w-full max-w-xs" defaultValue={defaultValue}>
      <Label>{label}</Label><Input /><Description>{hint}</Description>
    </TextField>`,
  },
  {
    slug: 'error-message',
    name: 'ErrorMessage',
    category: 'Forms',
    imports: ['ErrorMessage', 'Label', 'Tag', 'TagGroup'],
    props: { label: 'Topics', firstTopic: 'Design', secondTopic: 'Engineering', initialTopic: ['none', 'design', 'engineering'] },
    slots: { message: 'Choose at least one topic.' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [hasSelection, setHasSelection] = useState(initialTopic !== "none");',
    markup: `<TagGroup selectionMode="multiple" defaultSelectedKeys={initialTopic === "none" ? [] : [initialTopic]} onSelectionChange={(keys) => setHasSelection(keys === "all" || keys.size > 0)}>
      <Label>{label}</Label>
      <TagGroup.List>
        <Tag id="design" textValue={firstTopic}>{firstTopic}</Tag>
        <Tag id="engineering" textValue={secondTopic}>{secondTopic}</Tag>
      </TagGroup.List>
      <ErrorMessage>{!hasSelection && message}</ErrorMessage>
    </TagGroup>`,
  },
  {
    slug: 'field-error',
    name: 'FieldError',
    category: 'Forms',
    imports: ['FieldError', 'Input', 'Label', 'TextField'],
    props: { label: 'Username', defaultValue: 'jr', minimumLength: 3 },
    slots: { message: 'Enter at least three characters.' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: `const [value, setValue] = useState(defaultValue);
  const invalid = value.length < minimumLength;`,
    markup: `<TextField className="w-full max-w-xs" value={value} onChange={setValue} isInvalid={invalid} validationBehavior="aria">
      <Label>{label}</Label><Input autoComplete="username" /><FieldError>{message}</FieldError>
    </TextField>`,
  },
  {
    slug: 'fieldset',
    name: 'Fieldset',
    category: 'Forms',
    imports: ['Fieldset', 'Input', 'Label', 'TextField'],
    props: { legend: 'Shipping address', city: 'Lisbon', postalCode: '1100' },
    hydrate: true,
    markup: `<Fieldset className="w-full max-w-xs">
      <Fieldset.Legend>{legend}</Fieldset.Legend>
      <Fieldset.Group>
        <TextField defaultValue={city}><Label>City</Label><Input autoComplete="address-level2" /></TextField>
        <TextField defaultValue={postalCode}><Label>Postal code</Label><Input autoComplete="postal-code" /></TextField>
      </Fieldset.Group>
    </Fieldset>`,
  },
  {
    slug: 'form',
    name: 'Form',
    category: 'Forms',
    imports: ['Button', 'FieldError', 'Form', 'Input', 'Label', 'TextField'],
    props: { label: 'Email address', submitLabel: 'Subscribe', defaultValue: '' },
    slots: { confirmation: 'You’re on the list.' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [submitted, setSubmitted] = useState(false);',
    markup: `<Form className="grid w-full max-w-xs gap-3" validationBehavior="native"
      onSubmit={(event) => { event.preventDefault(); setSubmitted(true); }} onReset={() => setSubmitted(false)}>
      <TextField name="email" type="email" defaultValue={defaultValue} isRequired onChange={() => setSubmitted(false)}>
        <Label>{label}</Label><Input placeholder="you@example.com" autoComplete="email" /><FieldError />
      </TextField>
      <div className="flex flex-wrap gap-2"><Button type="submit">{submitLabel}</Button><Button type="reset" variant="secondary">Reset</Button></div>
      {submitted && <p role="status">{confirmation}</p>}
    </Form>`,
  },
  {
    slug: 'input',
    name: 'Input',
    category: 'Forms',
    imports: ['Input'],
    props: {
      label: 'Workspace name',
      placeholder: 'Enter a workspace name',
      defaultValue: 'Design team',
      type: ['text', 'email', 'password', 'url'],
      variant: FIELD_VARIANTS,
    },
    hydrate: true,
    markup: '<Input className="w-full max-w-xs" aria-label={label} placeholder={placeholder} defaultValue={defaultValue} type={type} variant={variant} />',
  },
  {
    slug: 'input-group',
    name: 'InputGroup',
    category: 'Forms',
    imports: ['InputGroup', 'Label', 'TextField'],
    props: { label: 'Workspace address', defaultValue: 'design', variant: FIELD_VARIANTS },
    slots: { suffix: '.example.com' },
    hydrate: true,
    markup: `<TextField className="w-full max-w-xs" defaultValue={defaultValue}>
      <Label>{label}</Label>
      <InputGroup variant={variant} className="w-full"><InputGroup.Input aria-label={label} className="min-w-0" /><InputGroup.Suffix>{suffix}</InputGroup.Suffix></InputGroup>
    </TextField>`,
  },
  {
    slug: 'input-otp',
    name: 'InputOTP',
    category: 'Forms',
    imports: ['InputOTP', 'REGEXP_ONLY_DIGITS'],
    props: { label: 'Verification code', defaultValue: '', variant: FIELD_VARIANTS },
    hydrate: true,
    markup: `<InputOTP aria-label={label} defaultValue={defaultValue.replace(/[^0-9]/g, "").slice(0, 6)} maxLength={6} pattern={REGEXP_ONLY_DIGITS} variant={variant}>
      <InputOTP.Group><InputOTP.Slot index={0} /><InputOTP.Slot index={1} /><InputOTP.Slot index={2} /></InputOTP.Group>
      <InputOTP.Separator />
      <InputOTP.Group><InputOTP.Slot index={3} /><InputOTP.Slot index={4} /><InputOTP.Slot index={5} /></InputOTP.Group>
    </InputOTP>`,
  },
  {
    slug: 'label',
    name: 'Label',
    category: 'Forms',
    imports: ['Input', 'Label'],
    props: { label: 'Account name', defaultValue: 'River Studio' },
    hydrate: true,
    extraImports: ID_IMPORT,
    setup: 'const id = useId();',
    markup: `<div className="grid w-full max-w-xs gap-1">
      <Label htmlFor={id}>{label}</Label><Input id={id} defaultValue={defaultValue} />
    </div>`,
  },
  {
    slug: 'number-field',
    name: 'NumberField',
    category: 'Forms',
    imports: ['Label', 'NumberField'],
    props: { label: 'Seats', defaultValue: 2, variant: FIELD_VARIANTS },
    hydrate: true,
    markup: `<NumberField className="w-full max-w-xs" minValue={1} maxValue={20} step={1} defaultValue={defaultValue} variant={variant}>
      <Label>{label}</Label>
      <NumberField.Group><NumberField.DecrementButton /><NumberField.Input /><NumberField.IncrementButton /></NumberField.Group>
    </NumberField>`,
  },
  {
    slug: 'radio-group',
    name: 'RadioGroup',
    category: 'Forms',
    imports: ['Description', 'Label', 'Radio', 'RadioGroup'],
    props: { label: 'Delivery speed', initialSpeed: ['standard', 'express'], firstOption: 'Standard', secondOption: 'Express' },
    slots: { hint: 'Choose when you need the package.' },
    hydrate: true,
    markup: `<RadioGroup defaultValue={initialSpeed}>
      <Label>{label}</Label><Description>{hint}</Description>
      <Radio value="standard"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{firstOption}</Radio.Content></Radio>
      <Radio value="express"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>{secondOption}</Radio.Content></Radio>
    </RadioGroup>`,
  },
  {
    slug: 'search-field',
    name: 'SearchField',
    category: 'Forms',
    imports: ['Label', 'SearchField'],
    props: { label: 'Find a project', defaultValue: '', placeholder: 'Search projects', variant: FIELD_VARIANTS },
    hydrate: true,
    markup: `<SearchField className="w-full max-w-xs" defaultValue={defaultValue} variant={variant}>
      <Label>{label}</Label><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={placeholder} /><SearchField.ClearButton /></SearchField.Group>
    </SearchField>`,
  },
  {
    slug: 'text-area',
    name: 'TextArea',
    category: 'Forms',
    imports: ['TextArea'],
    props: { label: 'Release summary', defaultValue: 'Updated billing and account settings.', rows: 3, variant: FIELD_VARIANTS },
    hydrate: true,
    markup: '<TextArea className="w-full max-w-sm" aria-label={label} defaultValue={defaultValue} rows={rows} variant={variant} />',
  },
  {
    slug: 'text-field',
    name: 'TextField',
    category: 'Forms',
    imports: ['Description', 'Input', 'Label', 'TextField'],
    props: { label: 'Project name', defaultValue: 'Spring launch', placeholder: 'Name your project', variant: FIELD_VARIANTS, isRequired: true },
    slots: { hint: 'Your team will see this name in the project list.' },
    hydrate: true,
    markup: `<TextField name="projectName" defaultValue={defaultValue} isRequired={isRequired} className="w-full max-w-xs">
      <Label>{label}</Label><Input placeholder={placeholder} variant={variant} /><Description>{hint}</Description>
    </TextField>`,
  },
];
