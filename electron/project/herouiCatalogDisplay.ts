import { HEROUI_COLORS, HEROUI_SIZES, HEROUI_SURFACES, type HeroUICatalogEntry } from './herouiCatalogTypes';

export const HEROUI_DISPLAY: readonly HeroUICatalogEntry[] = [
  {
    slug: 'alert',
    name: 'Alert',
    category: 'Feedback',
    imports: ['Alert'],
    props: { heading: 'Connection interrupted', status: ['warning', 'default', 'accent', 'success', 'danger'] },
    slots: { details: 'Your draft is saved. Reconnect to publish changes.' },
    markup: `<Alert status={status}>
      <Alert.Indicator />
      <Alert.Content><Alert.Title>{heading}</Alert.Title><Alert.Description>{details}</Alert.Description></Alert.Content>
    </Alert>`,
  },
  {
    slug: 'meter',
    name: 'Meter',
    category: 'Feedback',
    imports: ['Label', 'Meter'],
    props: { label: 'Storage used', value: 64 },
    markup: `<Meter className="w-full max-w-sm" minValue={0} maxValue={100} value={value}>
      <Label>{label}</Label><Meter.Output /><Meter.Track><Meter.Fill /></Meter.Track>
    </Meter>`,
  },
  {
    slug: 'progress-bar',
    name: 'ProgressBar',
    category: 'Feedback',
    imports: ['Label', 'ProgressBar'],
    props: { label: 'Uploading photos', value: 65, color: HEROUI_COLORS, size: HEROUI_SIZES, isIndeterminate: false },
    markup: `<ProgressBar className="w-full max-w-sm" minValue={0} maxValue={100} value={value} color={color} size={size} isIndeterminate={isIndeterminate}>
      <Label>{label}</Label><ProgressBar.Output /><ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
    </ProgressBar>`,
  },
  {
    slug: 'progress-circle',
    name: 'ProgressCircle',
    category: 'Feedback',
    imports: ['ProgressCircle'],
    props: { label: 'Profile complete', value: 75, color: HEROUI_COLORS, size: HEROUI_SIZES, isIndeterminate: false },
    markup: `<div className="flex items-center gap-3">
      <ProgressCircle aria-label={label} minValue={0} maxValue={100} value={value} color={color} size={size} isIndeterminate={isIndeterminate}>
        <ProgressCircle.Track><ProgressCircle.TrackCircle /><ProgressCircle.FillCircle /></ProgressCircle.Track>
      </ProgressCircle>
      <span aria-hidden="true">{label}</span>
    </div>`,
  },
  {
    slug: 'skeleton',
    name: 'Skeleton',
    category: 'Feedback',
    imports: ['Skeleton'],
    props: { label: 'Loading account', isLoading: true },
    slots: { body: 'Your account details are available.' },
    markup: `<div className="flex items-center gap-3" role="status">
      {isLoading ? <><span className="sr-only">{label}</span><Skeleton className="size-10 rounded-full" /><div className="w-36 space-y-2"><Skeleton className="h-3 w-full rounded-full" /><Skeleton className="h-3 w-2/3 rounded-full" /></div></> : body}
    </div>`,
  },
  {
    slug: 'spinner',
    name: 'Spinner',
    category: 'Feedback',
    imports: ['Spinner'],
    props: { label: 'Checking connection', size: ['md', 'sm', 'lg', 'xl'], color: ['accent', 'current', 'success', 'warning', 'danger'] },
    markup: '<div className="flex items-center gap-3"><Spinner aria-hidden="true" size={size} color={color} /><span role="status">{label}</span></div>',
  },
  {
    slug: 'card',
    name: 'Card',
    category: 'Layout',
    imports: ['Card'],
    props: { heading: 'Release checklist', description: 'Three tasks remain', variant: HEROUI_SURFACES },
    slots: { body: 'Review copy, test the build, and prepare the release notes.', footer: 'Due Friday' },
    markup: `<Card variant={variant} className="w-full max-w-sm border border-border">
      <Card.Header><Card.Title>{heading}</Card.Title><Card.Description>{description}</Card.Description></Card.Header>
      <Card.Content>{body}</Card.Content>
      <Card.Footer className="text-sm text-muted">{footer}</Card.Footer>
    </Card>`,
  },
  {
    slug: 'separator',
    name: 'Separator',
    category: 'Layout',
    imports: ['Separator'],
    props: { orientation: ['horizontal', 'vertical'] },
    slots: { before: 'Order total', after: 'Shipping calculated at checkout' },
    markup: `<div className={orientation === "vertical" ? "flex items-center gap-3" : "grid gap-3"}>
      <p className="font-semibold">{before}</p>
      <Separator orientation={orientation} className={orientation === "vertical" ? "h-8" : "w-full"} />
      <p className="text-sm text-muted">{after}</p>
    </div>`,
  },
  {
    slug: 'surface',
    name: 'Surface',
    category: 'Layout',
    imports: ['Surface', 'Typography'],
    props: { heading: 'Billing address', variant: ['secondary', 'default', 'tertiary', 'transparent'] },
    slots: { body: 'The address on your next invoice.' },
    markup: `<Surface variant={variant} className="w-full max-w-sm rounded-xl border border-border p-4">
      <Typography type="h4">{heading}</Typography>
      <Typography color="muted">{body}</Typography>
    </Surface>`,
  },
  {
    slug: 'avatar',
    name: 'Avatar',
    category: 'Media',
    imports: ['Avatar'],
    props: { name: 'Jules Davis', initials: 'JD', image: '', size: HEROUI_SIZES, color: HEROUI_COLORS, variant: ['soft', 'default'] },
    hydrate: true,
    markup: `<div className="flex items-center gap-3">
      <Avatar size={size} color={color} variant={variant} aria-hidden="true">
        {image !== "" && <Avatar.Image src={image} alt="" />}<Avatar.Fallback>{initials}</Avatar.Fallback>
      </Avatar>
      <span>{name}</span>
    </div>`,
  },
  {
    slug: 'avatar-group',
    name: 'AvatarGroup',
    category: 'Media',
    imports: ['Avatar', 'AvatarGroup'],
    props: { label: 'Design team', firstInitials: 'NK', secondInitials: 'JL', thirdInitials: 'AM', size: HEROUI_SIZES },
    markup: `<AvatarGroup aria-label={label} size={size} max={2} variant="soft">
      <Avatar color="accent"><Avatar.Fallback>{firstInitials}</Avatar.Fallback></Avatar>
      <Avatar color="success"><Avatar.Fallback>{secondInitials}</Avatar.Fallback></Avatar>
      <Avatar color="warning"><Avatar.Fallback>{thirdInitials}</Avatar.Fallback></Avatar>
    </AvatarGroup>`,
  },
  {
    slug: 'badge',
    name: 'Badge',
    category: 'Data display',
    imports: ['Avatar', 'Badge'],
    props: {
      initials: 'JD',
      label: 'Unread messages',
      count: 3,
      color: ['danger', 'default', 'accent', 'success', 'warning'],
      placement: ['top-right', 'top-left', 'bottom-right', 'bottom-left'],
    },
    markup: `<Badge.Anchor>
      <Avatar variant="soft" color="accent"><Avatar.Fallback>{initials}</Avatar.Fallback></Avatar>
      <Badge color={color} placement={placement} aria-label={count + " " + label}>{count}</Badge>
    </Badge.Anchor>`,
  },
  {
    slug: 'chip',
    name: 'Chip',
    category: 'Data display',
    imports: ['Chip'],
    props: {
      label: 'Published',
      color: ['success', 'default', 'accent', 'warning', 'danger'],
      variant: ['soft', 'primary', 'secondary', 'tertiary'],
      size: HEROUI_SIZES,
    },
    markup: '<Chip variant={variant} color={color} size={size}>{label}</Chip>',
  },
  {
    slug: 'table',
    name: 'Table',
    category: 'Data display',
    imports: ['Table'],
    props: { label: 'Release schedule', variant: ['primary', 'secondary'], firstRelease: 'Website', secondRelease: 'Design kit' },
    slots: { footer: 'All dates are shown in UTC.' },
    hydrate: true,
    markup: `<Table variant={variant}>
      <Table.ScrollContainer style={{ scrollbarGutter: "stable" }}>
        <Table.Content aria-label={label}>
          <Table.Header><Table.Column isRowHeader>Release</Table.Column><Table.Column>Date</Table.Column></Table.Header>
          <Table.Body>
            <Table.Row id="website"><Table.Cell>{firstRelease}</Table.Cell><Table.Cell>May 12</Table.Cell></Table.Row>
            <Table.Row id="kit"><Table.Cell>{secondRelease}</Table.Cell><Table.Cell>May 19</Table.Cell></Table.Row>
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      <Table.Footer>{footer}</Table.Footer>
    </Table>`,
  },
  {
    slug: 'kbd',
    name: 'Kbd',
    category: 'Typography',
    imports: ['Kbd'],
    props: { modifier: ['ctrl', 'command', 'shift', 'alt'], shortcut: 'K', label: 'Open search' },
    markup:
      '<div className="flex items-center gap-3"><Kbd><Kbd.Abbr keyValue={modifier} /><Kbd.Content>{shortcut}</Kbd.Content></Kbd><span>{label}</span></div>',
  },
  {
    slug: 'typography',
    name: 'Typography',
    category: 'Typography',
    imports: ['Typography'],
    props: { type: ['h4', 'h3', 'h2', 'h1', 'h5', 'h6', 'body', 'body-sm', 'body-xs', 'code'], color: ['default', 'muted'] },
    slots: { content: 'Design system updates' },
    markup: '<Typography type={type} color={color}>{content}</Typography>',
  },
  {
    slug: 'scroll-shadow',
    name: 'ScrollShadow',
    category: 'Utilities',
    imports: ['ScrollShadow'],
    props: { label: 'Release notes', size: 24 },
    slots: { introduction: 'Scroll to read the full release notes.' },
    hydrate: true,
    markup: `<ScrollShadow aria-label={label} className="h-28 max-w-sm" size={size} tabIndex={0} style={{ scrollbarGutter: "stable" }}>
      <div className="grid gap-3 px-2 text-sm">
        <p className="font-semibold">{introduction}</p>
        <p>Project members can now edit their notification preferences.</p>
        <p>Archived projects appear in search results when you enable the archive filter.</p>
        <p>CSV exports now use your workspace time zone.</p>
      </div>
    </ScrollShadow>`,
  },
  {
    slug: 'slider',
    name: 'Slider',
    category: 'Controls',
    imports: ['Label', 'Slider'],
    props: { label: 'Volume', defaultValue: 40 },
    hydrate: true,
    markup: `<Slider className="w-full max-w-sm" minValue={0} maxValue={100} step={5} defaultValue={defaultValue}>
      <Label>{label}</Label><Slider.Output />
      <Slider.Track><Slider.Fill /><Slider.Thumb /></Slider.Track>
    </Slider>`,
  },
  {
    slug: 'switch',
    name: 'Switch',
    category: 'Controls',
    imports: ['Description', 'Label', 'Switch'],
    props: { label: 'Email reminders', defaultSelected: true, size: HEROUI_SIZES },
    slots: { hint: 'Get a reminder before each deadline.' },
    hydrate: true,
    markup: `<Switch defaultSelected={defaultSelected} size={size}>
      <Switch.Control><Switch.Thumb /></Switch.Control>
      <Switch.Content><Label>{label}</Label><Description>{hint}</Description></Switch.Content>
    </Switch>`,
  },
];
