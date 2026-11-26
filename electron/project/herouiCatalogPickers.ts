import type { HeroUICatalogEntry } from './herouiCatalogTypes';

const COLORS = ['#2563EB', '#B91C1C', '#0F766E'] as const;
const VARIANTS = ['primary', 'secondary'] as const;
const COLOR_SIZES = ['md', 'xs', 'sm', 'lg', 'xl'] as const;
const COLOR_SHAPES = ['circle', 'square'] as const;
const DATE_IMPORT = 'import { readDate } from "./values";';
const RANGE_IMPORT = 'import { readDateRange } from "./values";';
const COLOR_IMPORT = 'import { readColor } from "./values";';

export const HEROUI_VALUE_SOURCE = `import { parseColor } from "@heroui/react";
import { parseDate, parseTime } from "@internationalized/date";

// Dates cross the Astro boundary as plain strings. Reject values that the date parser would clamp.
export function readDate(value: string) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    return undefined;
  }
  try {
    const date = parseDate(value);
    return date.toString() === value ? date : undefined;
  } catch {
    return undefined;
  }
}

export function readDateRange(startValue: string, endValue: string) {
  const start = readDate(startValue);
  const end = readDate(endValue);
  if (start === undefined || end === undefined || start.compare(end) > 0) {
    return undefined;
  }
  return { start, end };
}

export function readTime(value: string) {
  if (!/^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(value)) {
    return undefined;
  }
  return parseTime(value);
}

export function readColor(value: string) {
  if (value.length > 128) {
    return undefined;
  }
  try {
    return parseColor(value);
  } catch {
    return undefined;
  }
}
`;

export const HEROUI_PICKERS: readonly HeroUICatalogEntry[] = [
  {
    slug: 'calendar',
    name: 'Calendar',
    category: 'Date and time',
    imports: ['Calendar'],
    props: { label: 'Event date', defaultValue: '2026-06-18' },
    hydrate: true,
    extraImports: DATE_IMPORT,
    markup: `<Calendar aria-label={label} defaultValue={readDate(defaultValue) ?? null}>
      <Calendar.Header><Calendar.NavButton slot="previous" /><Calendar.Heading /><Calendar.NavButton slot="next" /></Calendar.Header>
      <Calendar.Grid>
        <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
        <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
      </Calendar.Grid>
    </Calendar>`,
  },
  {
    slug: 'date-field',
    name: 'DateField',
    category: 'Date and time',
    imports: ['DateField', 'Label'],
    props: { label: 'Deadline', defaultValue: '2026-06-18', variant: VARIANTS },
    hydrate: true,
    extraImports: DATE_IMPORT,
    markup: `<DateField className="w-full max-w-xs" defaultValue={readDate(defaultValue) ?? null}>
      <Label>{label}</Label>
      {/* React Aria puts the field ID on both parts. Keep it on the editable input. */}
      <DateField.Group variant={variant} render={(props) => <div {...props} id={undefined} />}><DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input></DateField.Group>
    </DateField>`,
  },
  {
    slug: 'date-picker',
    name: 'DatePicker',
    category: 'Date and time',
    imports: ['Calendar', 'DateField', 'DatePicker', 'Label'],
    props: { label: 'Delivery date', defaultValue: '2026-06-18' },
    hydrate: true,
    extraImports: DATE_IMPORT,
    markup: `<DatePicker className="w-full max-w-xs" defaultValue={readDate(defaultValue) ?? null}>
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix><DatePicker.Trigger><DatePicker.TriggerIndicator /></DatePicker.Trigger></DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover><Calendar aria-label={label}>
        <Calendar.Header><Calendar.NavButton slot="previous" /><Calendar.Heading /><Calendar.NavButton slot="next" /></Calendar.Header>
        <Calendar.Grid>
          <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
          <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
        </Calendar.Grid>
      </Calendar></DatePicker.Popover>
    </DatePicker>`,
  },
  {
    slug: 'date-range-picker',
    name: 'DateRangePicker',
    category: 'Date and time',
    imports: ['DateField', 'DateRangePicker', 'Label', 'RangeCalendar'],
    props: { label: 'Travel dates', startDate: '2026-06-18', endDate: '2026-06-23' },
    hydrate: true,
    extraImports: RANGE_IMPORT,
    markup: `<DateRangePicker className="w-full max-w-sm" startName="startDate" endName="endDate" defaultValue={readDateRange(startDate, endDate) ?? null}>
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input slot="start">{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateRangePicker.RangeSeparator />
        <DateField.Input slot="end">{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix><DateRangePicker.Trigger><DateRangePicker.TriggerIndicator /></DateRangePicker.Trigger></DateField.Suffix>
      </DateField.Group>
      <DateRangePicker.Popover><RangeCalendar aria-label={label}>
        <RangeCalendar.Header><RangeCalendar.NavButton slot="previous" /><RangeCalendar.Heading /><RangeCalendar.NavButton slot="next" /></RangeCalendar.Header>
        <RangeCalendar.Grid>
          <RangeCalendar.GridHeader>{(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}</RangeCalendar.GridHeader>
          <RangeCalendar.GridBody>{(date) => <RangeCalendar.Cell date={date} />}</RangeCalendar.GridBody>
        </RangeCalendar.Grid>
      </RangeCalendar></DateRangePicker.Popover>
    </DateRangePicker>`,
  },
  {
    slug: 'range-calendar',
    name: 'RangeCalendar',
    category: 'Date and time',
    imports: ['RangeCalendar'],
    props: { label: 'Sprint dates', startDate: '2026-06-15', endDate: '2026-06-26' },
    hydrate: true,
    extraImports: RANGE_IMPORT,
    markup: `<RangeCalendar aria-label={label} defaultValue={readDateRange(startDate, endDate) ?? null}>
      <RangeCalendar.Header><RangeCalendar.NavButton slot="previous" /><RangeCalendar.Heading /><RangeCalendar.NavButton slot="next" /></RangeCalendar.Header>
      <RangeCalendar.Grid>
        <RangeCalendar.GridHeader>{(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}</RangeCalendar.GridHeader>
        <RangeCalendar.GridBody>{(date) => <RangeCalendar.Cell date={date} />}</RangeCalendar.GridBody>
      </RangeCalendar.Grid>
    </RangeCalendar>`,
  },
  {
    slug: 'time-field',
    name: 'TimeField',
    category: 'Date and time',
    imports: ['Label', 'TimeField'],
    props: { label: 'Meeting time', defaultValue: '09:30', displayClock: ['24-hour', '12-hour'] },
    hydrate: true,
    extraImports: 'import { readTime } from "./values";',
    markup: `<TimeField defaultValue={readTime(defaultValue) ?? null} hourCycle={displayClock === "24-hour" ? 24 : 12} granularity="minute">
      <Label>{label}</Label>
      {/* React Aria puts the field ID on both parts. Keep it on the editable input. */}
      <TimeField.Group render={(props) => <div {...props} id={undefined} />}><TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input></TimeField.Group>
    </TimeField>`,
  },
  {
    slug: 'autocomplete',
    name: 'Autocomplete',
    category: 'Pickers',
    imports: ['Autocomplete', 'Label', 'ListBox', 'SearchField', 'useFilter'],
    props: { label: 'Project owner', initialOwner: ['jules', 'imani', 'nora'], firstOwner: 'Jules Davis', secondOwner: 'Imani Moore', thirdOwner: 'Nora Chen' },
    hydrate: true,
    setup: 'const { contains } = useFilter({ sensitivity: "base" });',
    markup: `<Autocomplete className="w-full max-w-xs" selectionMode="single" defaultValue={initialOwner}>
      <Label>{label}</Label>
      <Autocomplete.Trigger><Autocomplete.Value /><Autocomplete.ClearButton /><Autocomplete.Indicator /></Autocomplete.Trigger>
      <Autocomplete.Popover><Autocomplete.Filter filter={contains}>
        <SearchField autoFocus aria-label="Filter project owners">
          <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Search names" /><SearchField.ClearButton /></SearchField.Group>
        </SearchField>
        <ListBox renderEmptyState={() => "No matching owners"}>
          <ListBox.Item id="jules" textValue={firstOwner}>{firstOwner}<ListBox.ItemIndicator /></ListBox.Item>
          <ListBox.Item id="imani" textValue={secondOwner}>{secondOwner}<ListBox.ItemIndicator /></ListBox.Item>
          <ListBox.Item id="nora" textValue={thirdOwner}>{thirdOwner}<ListBox.ItemIndicator /></ListBox.Item>
        </ListBox>
      </Autocomplete.Filter></Autocomplete.Popover>
    </Autocomplete>`,
  },
  {
    slug: 'combo-box',
    name: 'ComboBox',
    category: 'Pickers',
    imports: ['ComboBox', 'Input', 'Label', 'ListBox'],
    props: { label: 'Office', placeholder: 'Find an office', initialOffice: ['lisbon', 'london', 'paris'] },
    hydrate: true,
    markup: `<ComboBox className="w-full max-w-xs" selectionMode="single" defaultValue={initialOffice}>
      <Label>{label}</Label>
      <ComboBox.InputGroup><Input placeholder={placeholder} /><ComboBox.Trigger /></ComboBox.InputGroup>
      <ComboBox.Popover><ListBox>
        <ListBox.Item id="lisbon" textValue="Lisbon">Lisbon<ListBox.ItemIndicator /></ListBox.Item>
        <ListBox.Item id="london" textValue="London">London<ListBox.ItemIndicator /></ListBox.Item>
        <ListBox.Item id="paris" textValue="Paris">Paris<ListBox.ItemIndicator /></ListBox.Item>
      </ListBox></ComboBox.Popover>
    </ComboBox>`,
  },
  {
    slug: 'select',
    name: 'Select',
    category: 'Pickers',
    imports: ['Description', 'Label', 'ListBox', 'Select'],
    props: { label: 'Priority', initialPriority: ['normal', 'low', 'high'], variant: VARIANTS },
    slots: { hint: 'Set how soon this work needs attention.' },
    hydrate: true,
    extraImports: 'import { useState } from "react";',
    setup: 'const [priority, setPriority] = useState<ExampleProps["initialPriority"] | null>(initialPriority);',
    markup: `<Select className="w-full max-w-xs" selectionMode="single" variant={variant} value={priority}
      onChange={(key) => setPriority(key === "normal" || key === "low" || key === "high" ? key : null)}>
      <Label>{label}</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      {hint && <Description>{hint}</Description>}
      <Select.Popover><ListBox>
        <ListBox.Item id="low" textValue="Low">Low<ListBox.ItemIndicator /></ListBox.Item>
        <ListBox.Item id="normal" textValue="Normal">Normal<ListBox.ItemIndicator /></ListBox.Item>
        <ListBox.Item id="high" textValue="High">High<ListBox.ItemIndicator /></ListBox.Item>
      </ListBox></Select.Popover>
    </Select>`,
  },
  {
    slug: 'color-area',
    name: 'ColorArea',
    category: 'Colors',
    imports: ['ColorArea'],
    props: { label: 'Saturation and brightness', defaultValue: '#2563EB' },
    hydrate: true,
    extraImports: COLOR_IMPORT,
    markup: `<ColorArea className="w-full max-w-xs" aria-label={label} defaultValue={readColor(defaultValue) ?? "#2563EB"} colorSpace="hsb" xChannel="saturation" yChannel="brightness">
      <ColorArea.Thumb />
    </ColorArea>`,
  },
  {
    slug: 'color-field',
    name: 'ColorField',
    category: 'Colors',
    imports: ['ColorField', 'ColorSwatch', 'Label'],
    props: { label: 'Accent color', defaultValue: '#2563EB', variant: VARIANTS },
    hydrate: true,
    extraImports: `import { useState } from "react";
${COLOR_IMPORT}`,
    setup: 'const [color, setColor] = useState(() => readColor(defaultValue) ?? null);',
    markup: `<ColorField className="w-full max-w-xs" value={color} onChange={setColor}>
      <Label>{label}</Label><ColorField.Group variant={variant}>
        <ColorField.Prefix><ColorSwatch size="xs" {...(color === null ? {} : { color })} /></ColorField.Prefix>
        <ColorField.Input />
      </ColorField.Group>
    </ColorField>`,
  },
  {
    slug: 'color-picker',
    name: 'ColorPicker',
    category: 'Colors',
    imports: ['ColorArea', 'ColorPicker', 'ColorSlider', 'ColorSwatch', 'Label'],
    props: { label: 'Pick an accent color', defaultValue: '#2563EB' },
    hydrate: true,
    extraImports: COLOR_IMPORT,
    markup: `<ColorPicker defaultValue={readColor(defaultValue) ?? "#2563EB"}>
      <ColorPicker.Trigger><ColorSwatch /><Label>{label}</Label></ColorPicker.Trigger>
      <ColorPicker.Popover>
        <ColorArea aria-label="Saturation and brightness" colorSpace="hsb" xChannel="saturation" yChannel="brightness"><ColorArea.Thumb /></ColorArea>
        <ColorSlider channel="hue" colorSpace="hsb"><Label>Hue</Label><ColorSlider.Output /><ColorSlider.Track><ColorSlider.Thumb /></ColorSlider.Track></ColorSlider>
      </ColorPicker.Popover>
    </ColorPicker>`,
  },
  {
    slug: 'color-slider',
    name: 'ColorSlider',
    category: 'Colors',
    imports: ['ColorSlider', 'Label'],
    props: { label: 'Adjust color', defaultValue: '#2563EB', channel: ['hue', 'saturation', 'lightness'] },
    hydrate: true,
    extraImports: COLOR_IMPORT,
    markup: `<ColorSlider className="w-full max-w-xs" defaultValue={readColor(defaultValue) ?? "#2563EB"} channel={channel} colorSpace="hsl">
      <Label>{label}</Label><ColorSlider.Output /><ColorSlider.Track><ColorSlider.Thumb /></ColorSlider.Track>
    </ColorSlider>`,
  },
  {
    slug: 'color-swatch',
    name: 'ColorSwatch',
    category: 'Colors',
    imports: ['ColorSwatch'],
    props: { label: 'Ocean blue', color: '#2563EB', size: COLOR_SIZES },
    extraImports: COLOR_IMPORT,
    markup:
      '<div className="flex items-center gap-3"><ColorSwatch aria-label={label} color={readColor(color) ?? "#2563EB"} size={size} /><span>{label}</span></div>',
  },
  {
    slug: 'color-swatch-picker',
    name: 'ColorSwatchPicker',
    category: 'Colors',
    imports: ['ColorSwatchPicker'],
    props: { label: 'Project color', defaultValue: COLORS, size: COLOR_SIZES, variant: COLOR_SHAPES },
    hydrate: true,
    markup: `<ColorSwatchPicker aria-label={label} defaultValue={defaultValue} size={size} variant={variant}>
      ${COLORS.map(
        (color) => `<ColorSwatchPicker.Item color="${color}"><ColorSwatchPicker.Swatch /><ColorSwatchPicker.Indicator /></ColorSwatchPicker.Item>`,
      ).join('\n      ')}
    </ColorSwatchPicker>`,
  },
];
