import { HEROUI_SIZES, type HeroUICatalogEntry } from './herouiCatalogTypes';

const STATE_IMPORT = 'import { useState } from "react";';
const PLACEMENTS = ['bottom', 'top', 'left', 'right'] as const;

export const HEROUI_ACTIONS: readonly HeroUICatalogEntry[] = [
  {
    slug: 'button',
    name: 'Button',
    category: 'Buttons',
    imports: ['Button'],
    props: {
      label: 'Save changes',
      variant: ['primary', 'secondary', 'tertiary', 'outline', 'ghost', 'danger', 'danger-soft'],
      size: HEROUI_SIZES,
      type: ['button', 'submit', 'reset'],
      isDisabled: false,
    },
    hydrate: true,
    markup: '<Button variant={variant} size={size} type={type} isDisabled={isDisabled}>{label}</Button>',
  },
  {
    slug: 'button-group',
    name: 'ButtonGroup',
    category: 'Buttons',
    imports: ['Button', 'ButtonGroup'],
    props: { label: 'Text zoom', variant: ['secondary', 'primary', 'tertiary', 'ghost', 'danger'], size: HEROUI_SIZES },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [zoom, setZoom] = useState(100);',
    markup: `<div className="space-y-3"><ButtonGroup aria-label={label} variant={variant} size={size}>
      <Button aria-label="Zoom out" isDisabled={zoom <= 50} onPress={() => setZoom((value) => value - 10)}>−</Button>
      <Button aria-label="Reset zoom" onPress={() => setZoom(100)}><ButtonGroup.Separator />{zoom}%</Button>
      <Button aria-label="Zoom in" isDisabled={zoom >= 200} onPress={() => setZoom((value) => value + 10)}><ButtonGroup.Separator />+</Button>
    </ButtonGroup><p style={{ fontSize: zoom + "%" }}>Preview text size.</p></div>`,
  },
  {
    slug: 'close-button',
    name: 'CloseButton',
    category: 'Buttons',
    imports: ['Button', 'CloseButton'],
    props: { label: 'Dismiss update', isDisabled: false },
    slots: { message: 'Your changes are saved.' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [visible, setVisible] = useState(true);',
    markup: `visible ? <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-secondary px-3 py-2">
      <p>{message}</p><CloseButton aria-label={label} isDisabled={isDisabled} onPress={() => setVisible(false)} />
    </div> : <Button variant="secondary" onPress={() => setVisible(true)}>Show update</Button>`,
  },
  {
    slug: 'toggle-button',
    name: 'ToggleButton',
    category: 'Buttons',
    imports: ['ToggleButton'],
    props: { label: 'Pin item', defaultSelected: false, size: HEROUI_SIZES },
    hydrate: true,
    markup: '<ToggleButton defaultSelected={defaultSelected} size={size}>{label}</ToggleButton>',
  },
  {
    slug: 'toggle-button-group',
    name: 'ToggleButtonGroup',
    category: 'Buttons',
    imports: ['ToggleButton', 'ToggleButtonGroup'],
    props: { label: 'Text alignment', initialAlignment: ['left', 'center', 'right'], size: HEROUI_SIZES },
    hydrate: true,
    markup: `<ToggleButtonGroup aria-label={label} selectionMode="single" disallowEmptySelection defaultSelectedKeys={[initialAlignment]} size={size}>
      <ToggleButton id="left">Left</ToggleButton>
      <ToggleButton id="center"><ToggleButtonGroup.Separator />Center</ToggleButton>
      <ToggleButton id="right"><ToggleButtonGroup.Separator />Right</ToggleButton>
    </ToggleButtonGroup>`,
  },
  {
    slug: 'accordion',
    name: 'Accordion',
    category: 'Navigation',
    imports: ['Accordion'],
    props: { heading: 'How do I change my plan?', secondHeading: 'When will the change take effect?', allowsMultipleExpanded: false },
    slots: { answer: 'Choose a plan in your billing settings.', secondAnswer: 'The new plan starts on your next billing date.' },
    hydrate: true,
    markup: `<Accordion allowsMultipleExpanded={allowsMultipleExpanded} defaultExpandedKeys={["plan"]}>
      <Accordion.Item id="plan">
        <Accordion.Heading><Accordion.Trigger>{heading}<Accordion.Indicator /></Accordion.Trigger></Accordion.Heading>
        <Accordion.Panel><Accordion.Body>{answer}</Accordion.Body></Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item id="date">
        <Accordion.Heading><Accordion.Trigger>{secondHeading}<Accordion.Indicator /></Accordion.Trigger></Accordion.Heading>
        <Accordion.Panel><Accordion.Body>{secondAnswer}</Accordion.Body></Accordion.Panel>
      </Accordion.Item>
    </Accordion>`,
  },
  {
    slug: 'breadcrumbs',
    name: 'Breadcrumbs',
    category: 'Navigation',
    imports: ['Breadcrumbs'],
    props: { homeLabel: 'Style Guide', homeHref: '/', parentLabel: 'Example Components', parentHref: '/example-components', currentLabel: 'Navigation' },
    markup: `<Breadcrumbs aria-label="Current location" className="flex-wrap">
      <Breadcrumbs.Item href={homeHref}>{homeLabel}</Breadcrumbs.Item>
      <Breadcrumbs.Item href={parentHref}>{parentLabel}</Breadcrumbs.Item>
      <Breadcrumbs.Item>{currentLabel}</Breadcrumbs.Item>
    </Breadcrumbs>`,
  },
  {
    slug: 'disclosure',
    name: 'Disclosure',
    category: 'Navigation',
    imports: ['Disclosure'],
    props: { heading: 'Shipping details', defaultExpanded: true },
    slots: { details: 'Orders ship within two business days.' },
    hydrate: true,
    markup: `<Disclosure defaultExpanded={defaultExpanded}>
      <Disclosure.Heading><Disclosure.Trigger>{heading}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
      <Disclosure.Content>{details}</Disclosure.Content>
    </Disclosure>`,
  },
  {
    slug: 'disclosure-group',
    name: 'DisclosureGroup',
    category: 'Navigation',
    imports: ['Disclosure', 'DisclosureGroup'],
    props: { firstHeading: 'Pickup', secondHeading: 'Delivery', allowsMultipleExpanded: false },
    slots: { pickup: 'Collect your order at the front desk.', delivery: 'Choose a delivery window at checkout.' },
    hydrate: true,
    markup: `<DisclosureGroup defaultExpandedKeys={["pickup"]} allowsMultipleExpanded={allowsMultipleExpanded}>
      <Disclosure id="pickup">
        <Disclosure.Heading><Disclosure.Trigger>{firstHeading}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
        <Disclosure.Content>{pickup}</Disclosure.Content>
      </Disclosure>
      <Disclosure id="delivery">
        <Disclosure.Heading><Disclosure.Trigger>{secondHeading}<Disclosure.Indicator /></Disclosure.Trigger></Disclosure.Heading>
        <Disclosure.Content>{delivery}</Disclosure.Content>
      </Disclosure>
    </DisclosureGroup>`,
  },
  {
    slug: 'link',
    name: 'Link',
    category: 'Navigation',
    imports: ['Link'],
    props: { label: 'Back to Style Guide', href: '/', showIcon: true },
    markup: '<Link href={href}>{label}{showIcon && <Link.Icon />}</Link>',
  },
  {
    slug: 'pagination',
    name: 'Pagination',
    category: 'Navigation',
    imports: ['Pagination'],
    props: { initialPage: ['first', 'second', 'third'], label: 'Search results' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: `const pages = ["first", "second", "third"] as const;
  const [page, setPage] = useState(pages.indexOf(initialPage));`,
    markup: `<Pagination aria-label={label}>
      <Pagination.Summary aria-live="polite">Showing {page * 10 + 1} to {(page + 1) * 10} of 30 results</Pagination.Summary>
      <Pagination.Content>
        <Pagination.Item><Pagination.Previous isDisabled={page === 0} onPress={() => setPage((value) => value - 1)}><Pagination.PreviousIcon /><span className="sr-only">Previous page</span></Pagination.Previous></Pagination.Item>
        {pages.map((key, index) => <Pagination.Item key={key}><Pagination.Link aria-label={"Page " + (index + 1)} isActive={page === index} onPress={() => setPage(index)}>{index + 1}</Pagination.Link></Pagination.Item>)}
        <Pagination.Item><Pagination.Next isDisabled={page === pages.length - 1} onPress={() => setPage((value) => value + 1)}><span className="sr-only">Next page</span><Pagination.NextIcon /></Pagination.Next></Pagination.Item>
      </Pagination.Content>
    </Pagination>`,
  },
  {
    slug: 'tabs',
    name: 'Tabs',
    category: 'Navigation',
    imports: ['Tabs'],
    props: { label: 'Project views', initialTab: ['overview', 'activity'], firstTab: 'Overview', secondTab: 'Activity' },
    slots: { overview: 'Two milestones are due this month.', activity: 'Nora updated the release checklist.' },
    hydrate: true,
    markup: `<Tabs defaultSelectedKey={initialTab}>
      <Tabs.ListContainer><Tabs.List aria-label={label}>
        <Tabs.Tab id="overview">{firstTab}<Tabs.Indicator /></Tabs.Tab>
        <Tabs.Tab id="activity">{secondTab}<Tabs.Indicator /></Tabs.Tab>
      </Tabs.List></Tabs.ListContainer>
      <Tabs.Panel id="overview">{overview}</Tabs.Panel>
      <Tabs.Panel id="activity">{activity}</Tabs.Panel>
    </Tabs>`,
  },
  {
    slug: 'alert-dialog',
    name: 'AlertDialog',
    category: 'Overlays',
    imports: ['AlertDialog', 'Button'],
    props: { trigger: 'Remove invitation', heading: 'Remove this invitation?', confirmLabel: 'Remove', variant: ['opaque', 'blur', 'transparent'] },
    slots: { body: 'The recipient will no longer be able to use this invitation.' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [removed, setRemoved] = useState(false);',
    markup: `<div className="space-y-3">
      <AlertDialog>
        <Button variant="danger-soft">{trigger}</Button>
        <AlertDialog.Backdrop variant={variant}><AlertDialog.Container><AlertDialog.Dialog>
          <AlertDialog.Header><AlertDialog.Icon status="danger" /><AlertDialog.Heading>{heading}</AlertDialog.Heading></AlertDialog.Header>
          <AlertDialog.Body>{body}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="secondary">Cancel</Button>
            <Button slot="close" variant="danger" onPress={() => setRemoved(true)}>{confirmLabel}</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog></AlertDialog.Container></AlertDialog.Backdrop>
      </AlertDialog>
      {removed && <p role="status">Invitation removed.</p>}
    </div>`,
  },
  {
    slug: 'drawer',
    name: 'Drawer',
    category: 'Overlays',
    imports: ['Button', 'Drawer'],
    props: { trigger: 'Open filters', heading: 'Product filters', placement: ['right', 'bottom', 'top', 'left'] },
    slots: { body: 'Choose a category on the results page to narrow the list.' },
    hydrate: true,
    markup: `<Drawer>
      <Button variant="secondary">{trigger}</Button>
      <Drawer.Backdrop><Drawer.Content placement={placement}><Drawer.Dialog>
        <Drawer.CloseTrigger />
        <Drawer.Header><Drawer.Heading>{heading}</Drawer.Heading></Drawer.Header>
        <Drawer.Body>{body}</Drawer.Body>
        <Drawer.Footer><Button slot="close" variant="secondary">Done</Button></Drawer.Footer>
      </Drawer.Dialog></Drawer.Content></Drawer.Backdrop>
    </Drawer>`,
  },
  {
    slug: 'modal',
    name: 'Modal',
    category: 'Overlays',
    imports: ['Button', 'Modal'],
    props: {
      trigger: 'Edit project',
      heading: 'Project settings',
      size: ['md', 'xs', 'sm', 'lg', 'cover', 'full'],
      variant: ['blur', 'opaque', 'transparent'],
    },
    slots: { body: 'Choose the priority for this project.', footer: 'Done' },
    hydrate: true,
    extraImports: 'import { Example as PrioritySelect } from "./Select";',
    markup: `<Modal>
      <Button>{trigger}</Button>
      <Modal.Backdrop variant={variant}><Modal.Container size={size}><Modal.Dialog>
        <Modal.CloseTrigger />
        <Modal.Header><Modal.Heading>{heading}</Modal.Heading></Modal.Header>
        <Modal.Body className="space-y-4"><div>{body}</div><PrioritySelect label="Project priority" initialPriority="normal" variant="secondary" /></Modal.Body>
        <Modal.Footer><Button variant="secondary" slot="close">{footer}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal>`,
  },
  {
    slug: 'popover',
    name: 'Popover',
    category: 'Overlays',
    imports: ['Button', 'Popover'],
    props: { trigger: 'Team access', heading: 'Who can view this?', placement: PLACEMENTS },
    slots: { body: 'Anyone on your team can view this project.' },
    hydrate: true,
    markup: `<Popover>
      <Button variant="secondary">{trigger}</Button>
      <Popover.Content placement={placement}>
        <Popover.Arrow /><Popover.Dialog><Popover.Heading>{heading}</Popover.Heading><p>{body}</p></Popover.Dialog>
      </Popover.Content>
    </Popover>`,
  },
  {
    slug: 'sheet',
    name: 'Sheet',
    category: 'Overlays',
    imports: ['Button', 'Sheet'],
    props: { trigger: 'Open delivery options', heading: 'Delivery options', placement: PLACEMENTS, isDetached: false },
    slots: { body: 'Standard delivery takes three to five business days.' },
    hydrate: true,
    markup: `<Sheet placement={placement} isDetached={isDetached}>
      <Sheet.Trigger><Button variant="secondary">{trigger}</Button></Sheet.Trigger>
      <Sheet.Backdrop><Sheet.Content><Sheet.Dialog>
        <Sheet.Handle /><Sheet.CloseTrigger />
        <Sheet.Header><Sheet.Heading>{heading}</Sheet.Heading></Sheet.Header>
        <Sheet.Body>{body}</Sheet.Body>
        <Sheet.Footer><Sheet.Close><Button variant="secondary">Done</Button></Sheet.Close></Sheet.Footer>
      </Sheet.Dialog></Sheet.Content></Sheet.Backdrop>
    </Sheet>`,
  },
  {
    slug: 'toast',
    name: 'Toast',
    category: 'Overlays',
    imports: ['Button', 'Toast', 'ToastQueue'],
    props: {
      label: 'Show notification',
      title: 'Report exported',
      description: 'Your file is ready to download.',
      variant: ['success', 'default', 'accent', 'warning', 'danger'],
    },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [queue] = useState(() => new ToastQueue({ maxVisibleToasts: 1 }));',
    markup: `<>
      <Button variant="secondary" onPress={() => { queue.clear(); queue.add({ title, description, variant }, { timeout: 5000 }); }}>{label}</Button>
      <Toast.Provider queue={queue} placement="bottom end" />
    </>`,
  },
  {
    slug: 'tooltip',
    name: 'Tooltip',
    category: 'Overlays',
    imports: ['Button', 'Tooltip'],
    props: { label: 'Keyboard shortcut', placement: ['top', 'bottom', 'left', 'right'] },
    slots: { tip: 'Press Escape to close an open dialog.' },
    hydrate: true,
    markup: `<Tooltip>
      <Button variant="secondary">{label}</Button>
      <Tooltip.Content placement={placement}><Tooltip.Arrow />{tip}</Tooltip.Content>
    </Tooltip>`,
  },
  {
    slug: 'dropdown',
    name: 'Dropdown',
    category: 'Collections',
    imports: ['Button', 'Dropdown', 'Label'],
    props: { label: 'Sort results', initialSort: ['recent', 'name'], recentLabel: 'Most recent', nameLabel: 'Name' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: 'const [sort, setSort] = useState<string>(initialSort);',
    markup: `<div className="space-y-2">
      <Dropdown>
        <Button variant="secondary">{label}</Button>
        <Dropdown.Popover><Dropdown.Menu aria-label={label} selectionMode="single" selectedKeys={[sort]} disallowEmptySelection onAction={(key) => setSort(String(key))}>
          <Dropdown.Item id="recent" textValue={recentLabel}><Label>{recentLabel}</Label><Dropdown.ItemIndicator /></Dropdown.Item>
          <Dropdown.Item id="name" textValue={nameLabel}><Label>{nameLabel}</Label><Dropdown.ItemIndicator /></Dropdown.Item>
        </Dropdown.Menu></Dropdown.Popover>
      </Dropdown>
      <p role="status" className="text-sm text-muted">Sorted by {sort === "recent" ? recentLabel : nameLabel}</p>
    </div>`,
  },
  {
    slug: 'list-box',
    name: 'ListBox',
    category: 'Collections',
    imports: ['Description', 'Label', 'ListBox'],
    props: { label: 'Export format', initialFormat: ['pdf', 'csv'], pdfLabel: 'PDF', csvLabel: 'CSV' },
    hydrate: true,
    markup: `<ListBox aria-label={label} className="max-w-sm" selectionMode="single" defaultSelectedKeys={[initialFormat]}>
      <ListBox.Item id="pdf" textValue={pdfLabel}><Label>{pdfLabel}</Label><Description>Print-ready document</Description><ListBox.ItemIndicator /></ListBox.Item>
      <ListBox.Item id="csv" textValue={csvLabel}><Label>{csvLabel}</Label><Description>Spreadsheet data</Description><ListBox.ItemIndicator /></ListBox.Item>
    </ListBox>`,
  },
  {
    slug: 'tag-group',
    name: 'TagGroup',
    category: 'Collections',
    imports: ['Label', 'Tag', 'TagGroup'],
    props: { label: 'Project tags', firstTag: 'Design', secondTag: 'Review', thirdTag: 'Release' },
    hydrate: true,
    extraImports: STATE_IMPORT,
    setup: `const [tags, setTags] = useState([
    { id: "design", label: firstTag },
    { id: "review", label: secondTag },
    { id: "release", label: thirdTag },
  ]);`,
    markup: `<TagGroup onRemove={(keys) => setTags((current) => current.filter((tag) => !keys.has(tag.id)))}>
      <Label>{label}</Label>
      <TagGroup.List renderEmptyState={() => "No tags"}>
        {tags.map((tag) => <Tag key={tag.id} id={tag.id} textValue={tag.label}>{tag.label}<Tag.RemoveButton /></Tag>)}
      </TagGroup.List>
    </TagGroup>`,
  },
  {
    slug: 'toolbar',
    name: 'Toolbar',
    category: 'Layout',
    imports: ['Separator', 'ToggleButton', 'ToggleButtonGroup', 'Toolbar'],
    props: { label: 'Editor settings', firstLabel: 'Bold', secondLabel: 'Italic', thirdLabel: 'Wrap' },
    hydrate: true,
    markup: `<Toolbar aria-label={label} className="flex flex-wrap items-center gap-2">
      <ToggleButtonGroup aria-label="Text styles" selectionMode="multiple" size="sm">
        <ToggleButton id="bold">{firstLabel}</ToggleButton>
        <ToggleButton id="italic"><ToggleButtonGroup.Separator />{secondLabel}</ToggleButton>
      </ToggleButtonGroup>
      <Separator orientation="vertical" className="h-6" />
      <ToggleButton size="sm">{thirdLabel}</ToggleButton>
    </Toolbar>`,
  },
];
