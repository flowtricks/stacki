// Each adapter composes the installed React exports in one island so providers, portals and triggers share state.
import type { ShadcnBase } from '../../shared/ipc/shadcnStarter';

export interface CatalogExample {
  readonly label: string;
  readonly imports: string;
  readonly markup: string;
  readonly hydrate?: true;
  readonly setup?: string;
  readonly module?: string;
}

export function catalogExamples(base: ShadcnBase) {
  const itemProperty = base === 'aria' ? 'id' : 'value';
  const popup = (names: { readonly root: string; readonly trigger: string; readonly content: string }, contents: string): string => {
    const { root, trigger, content } = names;
    const button = '<Button variant="outline">{label}</Button>';
    if (base === 'aria') {
      return `<${trigger}>${button}<${root}>${contents}</${root}></${trigger}>`;
    }
    return `<${root}>${buttonTrigger(trigger, base, '{label}')}<${content}>${contents}</${content}></${root}>`;
  };

  return {
    accordion: {
      label: 'How do project reviews work?',
      imports: ui('accordion', 'Accordion, AccordionItem, AccordionTrigger, AccordionContent'),
      markup: `<Accordion${base === 'radix' ? ' type="single" collapsible' : ''}>
        <AccordionItem ${itemProperty}="review">
          <AccordionTrigger>{label}</AccordionTrigger>
          <AccordionContent>Leave feedback before the review closes on Thursday.</AccordionContent>
        </AccordionItem>
      </Accordion>`,
      hydrate: true,
    },
    alert: {
      label: 'Review is ready',
      imports: ui('alert', 'Alert, AlertTitle, AlertDescription'),
      markup: '<Alert><AlertTitle>{label}</AlertTitle><AlertDescription>Open the activity log for the latest changes.</AlertDescription></Alert>',
    },
    'alert-dialog': {
      label: 'Archive project',
      imports: [
        ui('button', 'Button'),
        ui(
          'alert-dialog',
          `AlertDialog, AlertDialogTrigger, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction${base === 'aria' ? '' : ', AlertDialogContent'}`,
        ),
      ].join('\n'),
      markup: popup(
        { root: 'AlertDialog', trigger: 'AlertDialogTrigger', content: 'AlertDialogContent' },
        '<AlertDialogHeader><AlertDialogTitle>Archive this project?</AlertDialogTitle><AlertDialogDescription>It will move out of the active projects list.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction>Archive</AlertDialogAction></AlertDialogFooter>',
      ),
      hydrate: true,
    },
    'aspect-ratio': {
      label: '16:9 preview',
      imports: ui('aspect-ratio', 'AspectRatio'),
      markup: '<AspectRatio ratio={16 / 9} className="grid place-items-center rounded-lg bg-muted text-muted-foreground">{label}</AspectRatio>',
    },
    attachment: {
      label: 'Project brief.pdf',
      imports: ui('attachment', 'Attachment, AttachmentContent, AttachmentDescription, AttachmentTitle'),
      markup:
        '<Attachment><AttachmentContent><AttachmentTitle>{label}</AttachmentTitle><AttachmentDescription>PDF · 240 KB</AttachmentDescription></AttachmentContent></Attachment>',
    },
    avatar: {
      label: 'Alex Rivera',
      imports: ui('avatar', 'Avatar, AvatarFallback'),
      markup: '<Avatar aria-label={label}><AvatarFallback aria-hidden="true">{label.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>',
    },
    badge: {
      label: 'In review',
      imports: ui('badge', 'Badge'),
      markup: '<Badge variant="secondary">{label}</Badge>',
    },
    breadcrumb: {
      label: 'Field notes',
      imports: ui('breadcrumb', `Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage${base === 'aria' ? '' : ', BreadcrumbSeparator'}`),
      markup: `<Breadcrumb><BreadcrumbList><BreadcrumbItem><BreadcrumbLink href="/">Projects</BreadcrumbLink></BreadcrumbItem>
        ${base === 'aria' ? '' : '<BreadcrumbSeparator />'}<BreadcrumbItem><BreadcrumbPage>{label}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>`,
    },
    bubble: {
      label: 'Can you review the latest draft?',
      imports: ui('bubble', 'Bubble, BubbleContent'),
      markup: '<Bubble variant="secondary"><BubbleContent>{label}</BubbleContent></Bubble>',
    },
    'button-group': {
      label: 'Save draft',
      imports: [ui('button', 'Button'), ui('button-group', 'ButtonGroup')].join('\n'),
      markup:
        '<ButtonGroup aria-label="Publication actions"><Button variant="outline">{label}</Button><Button variant="outline">Publish</Button></ButtonGroup>',
    },
    calendar: {
      label: 'Project calendar',
      imports: ui('calendar', 'Calendar'),
      markup: `<div aria-label={label} role="group"><Calendar${base === 'aria' ? ' aria-label={label}' : ' mode="single"'} className="rounded-lg border" /></div>`,
      hydrate: true,
    },
    carousel: {
      label: 'Project updates',
      imports: ui('carousel', 'Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext'),
      markup: `<Carousel aria-label={label} className="mx-12">
        <CarouselContent>{["Brief", "Draft", "Review"].map((step) => <CarouselItem key={step}>
          <div className="grid aspect-video place-items-center rounded-lg border bg-card font-medium text-card-foreground">{step}</div>
        </CarouselItem>)}</CarouselContent><CarouselPrevious /><CarouselNext />
      </Carousel>`,
      hydrate: true,
    },
    chart: {
      label: 'Tasks completed each week',
      imports: `import { Bar, BarChart, XAxis } from "recharts";
${ui('chart', 'ChartContainer, ChartTooltip, ChartTooltipContent')}`,
      module: 'const activity = [{ week: "Week 1", tasks: 6 }, { week: "Week 2", tasks: 11 }, { week: "Week 3", tasks: 8 }];',
      markup: `<figure><figcaption className="mb-2 text-sm font-medium">{label}</figcaption>
        <ChartContainer config={{ tasks: { label: "Tasks", color: "var(--chart-1)" } }} className="min-h-40 w-full max-w-md">
          <BarChart accessibilityLayer data={activity}><XAxis dataKey="week" /><ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="tasks" fill="var(--color-tasks)" radius={4} />
          </BarChart>
        </ChartContainer></figure>`,
      hydrate: true,
    },
    checkbox: {
      label: 'Include completed tasks',
      imports: fieldControl('checkbox', 'Checkbox'),
      setup: 'const identifier = useId();',
      markup: '<Field orientation="horizontal"><Checkbox id={identifier} /><FieldLabel htmlFor={identifier}>{label}</FieldLabel></Field>',
      hydrate: true,
    },
    'code-block': {
      label: 'Terminal',
      imports: ui('code-block', 'CodeBlock, CodeBlockHeader, CodeBlockTitle, CodeBlockActions, CodeBlockCopyButton, CodeBlockContent'),
      setup: 'const command = "npm run dev";',
      markup:
        '<CodeBlock><CodeBlockHeader><CodeBlockTitle>{label}</CodeBlockTitle><CodeBlockActions><CodeBlockCopyButton value={command} /></CodeBlockActions></CodeBlockHeader><CodeBlockContent>{command}</CodeBlockContent></CodeBlock>',
      hydrate: true,
    },
    collapsible: {
      label: 'Show review notes',
      imports: `${ui('collapsible', 'Collapsible, CollapsibleTrigger, CollapsibleContent')}
${base === 'aria' ? '' : ui('button', 'Button')}`,
      markup: `<Collapsible>${base === 'aria' ? '<CollapsibleTrigger className="rounded-lg border px-3 py-2 text-sm font-medium">{label}</CollapsibleTrigger>' : buttonTrigger('CollapsibleTrigger', base, '{label}')}
        <CollapsibleContent className="mt-2 rounded-md border p-3">Bring a first draft to the review.</CollapsibleContent></Collapsible>`,
      hydrate: true,
    },
    combobox: {
      label: 'Select a project',
      imports: ui('combobox', 'Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty'),
      module: 'const projects = ["Field notes", "Archive", "Studio"];',
      markup:
        base === 'aria'
          ? '<Combobox allowsEmptyCollection><ComboboxInput aria-label={label} placeholder={label} /><ComboboxContent><ComboboxList renderEmptyState={() => <ComboboxEmpty>No projects found.</ComboboxEmpty>}>{projects.map((project) => <ComboboxItem key={project} id={project}>{project}</ComboboxItem>)}</ComboboxList></ComboboxContent></Combobox>'
          : '<Combobox items={projects}><ComboboxInput aria-label={label} placeholder={label} /><ComboboxContent><ComboboxEmpty>No projects found.</ComboboxEmpty><ComboboxList>{(project: string) => <ComboboxItem key={project} value={project}>{project}</ComboboxItem>}</ComboboxList></ComboboxContent></Combobox>',
      hydrate: true,
    },
    command: {
      label: 'Search commands',
      imports: ui('command', 'Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem'),
      markup:
        '<Command className="max-w-sm rounded-lg border"><CommandInput placeholder={label} aria-label={label} /><CommandList><CommandEmpty>No matches.</CommandEmpty><CommandGroup heading="Projects"><CommandItem>Open recent</CommandItem><CommandItem>Create project</CommandItem></CommandGroup></CommandList></Command>',
      hydrate: true,
    },
    'context-menu': {
      label: 'Right-click for actions',
      imports: `${ui('context-menu', `ContextMenu, ContextMenuTrigger, ContextMenuGroup, ContextMenuItem${base === 'aria' ? '' : ', ContextMenuContent'}`)}
${base === 'aria' ? 'import { Pressable } from "react-aria-components";' : ''}`,
      markup:
        base === 'aria'
          ? '<ContextMenuTrigger><Pressable><button type="button" className="rounded-lg border border-dashed p-6">{label}</button></Pressable><ContextMenu><ContextMenuGroup><ContextMenuItem>Rename</ContextMenuItem><ContextMenuItem>Duplicate</ContextMenuItem></ContextMenuGroup></ContextMenu></ContextMenuTrigger>'
          : '<ContextMenu><ContextMenuTrigger className="grid place-items-center rounded-lg border border-dashed p-6">{label}</ContextMenuTrigger><ContextMenuContent><ContextMenuGroup><ContextMenuItem>Rename</ContextMenuItem><ContextMenuItem>Duplicate</ContextMenuItem></ContextMenuGroup></ContextMenuContent></ContextMenu>',
      hydrate: true,
    },
    direction: {
      label: 'Reading order',
      imports: `${ui('button', 'Button')}
${ui('button-group', 'ButtonGroup')}
import { usePreviewDirection } from "../PreviewDirection";`,
      module: `function DirectionSample({ label }: { readonly label: string }) {
  const direction = usePreviewDirection();
  return <ButtonGroup dir={direction} aria-label={label}><Button variant="outline">Start</Button><Button variant="outline">End</Button></ButtonGroup>;
}`,
      markup: '<DirectionSample label={label} />',
      hydrate: true,
    },
    drawer: {
      label: 'Open drawer',
      imports: [ui('button', 'Button'), ui('drawer', 'Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription')].join('\n'),
      markup: `<Drawer>${buttonTrigger('DrawerTrigger', base === 'aria' ? 'base' : base, '{label}')}
        <DrawerContent><DrawerHeader><DrawerTitle>Project activity</DrawerTitle><DrawerDescription>See changes made this week.</DrawerDescription></DrawerHeader></DrawerContent>
      </Drawer>`,
      hydrate: true,
    },
    'dropdown-menu': {
      label: 'Project actions',
      imports: [
        ui('button', 'Button'),
        ui('dropdown-menu', `DropdownMenu, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuItem${base === 'aria' ? '' : ', DropdownMenuContent'}`),
      ].join('\n'),
      markup: popup(
        { root: 'DropdownMenu', trigger: 'DropdownMenuTrigger', content: 'DropdownMenuContent' },
        '<DropdownMenuGroup><DropdownMenuItem>Open project</DropdownMenuItem><DropdownMenuItem>Duplicate project</DropdownMenuItem></DropdownMenuGroup>',
      ),
      hydrate: true,
    },
    empty: {
      label: 'No projects yet',
      imports: ui('empty', 'Empty, EmptyHeader, EmptyTitle, EmptyDescription'),
      markup:
        '<Empty className="border"><EmptyHeader><EmptyTitle>{label}</EmptyTitle><EmptyDescription>Projects appear here after you create them.</EmptyDescription></EmptyHeader></Empty>',
    },
    form: {
      label: 'Project name',
      imports: `import { useId, useState } from "react";
${ui('field', 'Field, FieldGroup, FieldLabel')}
${ui('input', 'Input')}
${ui('button', 'Button')}`,
      setup: 'const identifier = useId();\n  const [saved, setSaved] = useState(false);',
      markup: `<form className="max-w-sm" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
        <FieldGroup><Field><FieldLabel htmlFor={identifier}>{label}</FieldLabel><Input id={identifier} name="projectName" required /></Field>
          <Button type="submit">Save project</Button>
        </FieldGroup>
        {saved && <p role="status" className="mt-2 text-sm text-muted-foreground">Project saved for this preview.</p>}
      </form>`,
      hydrate: true,
    },
    'hover-card': {
      label: '@alex',
      imports: [ui('button', 'Button'), ui('hover-card', `HoverCard, HoverCardTrigger${base === 'aria' ? '' : ', HoverCardContent'}`)].join('\n'),
      markup: popup(
        { root: 'HoverCard', trigger: 'HoverCardTrigger', content: 'HoverCardContent' },
        '<p className="text-sm">Alex Rivera maintains the project activity log.</p>',
      ),
      hydrate: true,
    },
    'input-group': {
      label: 'Project URL',
      imports: ui('input-group', 'InputGroup, InputGroupAddon, InputGroupInput, InputGroupText'),
      markup:
        '<InputGroup><InputGroupAddon><InputGroupText>https://</InputGroupText></InputGroupAddon><InputGroupInput aria-label={label} placeholder="example.com" /></InputGroup>',
    },
    'input-otp': {
      label: 'Verification code',
      imports: ui('input-otp', 'InputOTP, InputOTPGroup, InputOTPSlot'),
      markup:
        '<InputOTP maxLength={6} aria-label={label}><InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((index) => <InputOTPSlot key={index} index={index} />)}</InputOTPGroup></InputOTP>',
      hydrate: true,
    },
    item: {
      label: 'Field notes',
      imports: ui('item', 'Item, ItemContent, ItemTitle, ItemDescription'),
      markup:
        '<Item variant="outline"><ItemContent><ItemTitle>{label}</ItemTitle><ItemDescription>Updated by the project team this morning.</ItemDescription></ItemContent></Item>',
    },
    kbd: {
      label: 'Search projects',
      imports: ui('kbd', 'Kbd, KbdGroup'),
      markup: '<span className="inline-flex items-center gap-2 text-sm">{label}<KbdGroup><Kbd>Ctrl</Kbd><Kbd>K</Kbd></KbdGroup></span>',
    },
    label: {
      label: 'Project title',
      imports: `import { useId } from "react";
${ui('label', 'Label')}
${ui('input', 'Input')}`,
      setup: 'const identifier = useId();',
      markup: '<div className="grid gap-2"><Label htmlFor={identifier}>{label}</Label><Input id={identifier} placeholder="Field notes" /></div>',
    },
    marker: {
      label: 'Review started',
      imports: ui('marker', 'Marker, MarkerContent'),
      markup: '<Marker><MarkerContent>{label}</MarkerContent></Marker>',
    },
    menubar: {
      label: 'File',
      imports: ui('menubar', 'Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarGroup, MenubarItem'),
      markup:
        '<Menubar><MenubarMenu><MenubarTrigger>{label}</MenubarTrigger><MenubarContent><MenubarGroup><MenubarItem>Open</MenubarItem><MenubarItem>Rename</MenubarItem></MenubarGroup></MenubarContent></MenubarMenu></Menubar>',
      hydrate: true,
    },
    message: {
      label: 'The latest draft is ready for review.',
      imports: [ui('message', 'Message, MessageContent, MessageHeader'), ui('bubble', 'Bubble, BubbleContent')].join('\n'),
      markup: '<Message><MessageHeader>Alex</MessageHeader><MessageContent><Bubble><BubbleContent>{label}</BubbleContent></Bubble></MessageContent></Message>',
    },
    'message-scroller': messageScroller(),
    'native-select': {
      label: 'Project status',
      imports: ui('native-select', 'NativeSelect, NativeSelectOption'),
      markup:
        '<NativeSelect aria-label={label} defaultValue="draft"><NativeSelectOption value="draft">Draft</NativeSelectOption><NativeSelectOption value="review">In review</NativeSelectOption></NativeSelect>',
    },
    'navigation-menu': {
      label: 'Project pages',
      imports: ui(
        'navigation-menu',
        'NavigationMenu, NavigationMenuList, NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink',
      ),
      markup:
        '<NavigationMenu><NavigationMenuList><NavigationMenuItem><NavigationMenuTrigger>{label}</NavigationMenuTrigger><NavigationMenuContent><NavigationMenuLink href="/">Overview</NavigationMenuLink><NavigationMenuLink href="/example-components">Components</NavigationMenuLink></NavigationMenuContent></NavigationMenuItem></NavigationMenuList></NavigationMenu>',
      hydrate: true,
    },
    pagination: {
      label: 'Project pages',
      imports: ui('pagination', 'Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious'),
      markup:
        '<Pagination aria-label={label}><PaginationContent><PaginationItem><PaginationPrevious href="?page=1" /></PaginationItem><PaginationItem><PaginationLink href="?page=2" isActive>2</PaginationLink></PaginationItem><PaginationItem><PaginationNext href="?page=3" /></PaginationItem></PaginationContent></Pagination>',
    },
    popover: {
      label: 'Project details',
      imports: popoverImports(base),
      markup: popup(
        { root: 'Popover', trigger: 'PopoverTrigger', content: 'PopoverContent' },
        '<PopoverHeader><PopoverTitle>Field notes</PopoverTitle><PopoverDescription>Review closes Thursday at noon.</PopoverDescription></PopoverHeader>',
      ),
      hydrate: true,
    },
    progress: {
      label: 'Review progress',
      imports: ui('progress', 'Progress'),
      markup: '<div className="grid gap-2"><p className="text-sm font-medium">{label}</p><Progress aria-label={label} value={60} /></div>',
    },
    questionnaire: questionnaire(),
    'radio-group': {
      label: 'Review schedule',
      imports: fieldControl('radio-group', 'RadioGroup, RadioGroupItem'),
      setup: 'const identifier = useId();',
      markup: `<RadioGroup aria-label={label} defaultValue="weekly">
        <Field orientation="horizontal"><RadioGroupItem value="weekly" id={identifier + "-weekly"} /><FieldLabel htmlFor={identifier + "-weekly"}>Weekly</FieldLabel></Field>
        <Field orientation="horizontal"><RadioGroupItem value="monthly" id={identifier + "-monthly"} /><FieldLabel htmlFor={identifier + "-monthly"}>Monthly</FieldLabel></Field>
      </RadioGroup>`,
      hydrate: true,
    },
    resizable: {
      label: 'Resizable project view',
      imports: ui('resizable', 'ResizablePanelGroup, ResizablePanel, ResizableHandle'),
      markup:
        '<ResizablePanelGroup orientation="horizontal" aria-label={label} className="min-h-24 rounded-lg border"><ResizablePanel defaultSize="35%"><div className="p-3">Files</div></ResizablePanel><ResizableHandle withHandle /><ResizablePanel defaultSize="65%"><div className="p-3">Project notes</div></ResizablePanel></ResizablePanelGroup>',
      hydrate: true,
    },
    'scroll-area': {
      label: 'Activity history',
      imports: ui('scroll-area', 'ScrollArea'),
      markup:
        '<ScrollArea className="h-28 rounded-md border"><div className="grid gap-2 p-3"><p className="font-medium">{label}</p>{["Draft created", "Review started", "Feedback added", "Revision saved", "Review completed"].map((note) => <p key={note} className="text-sm">{note}</p>)}</div></ScrollArea>',
      hydrate: true,
    },
    select: selectExample(base),
    separator: {
      label: 'Project settings',
      imports: ui('separator', 'Separator'),
      markup:
        '<div className="grid gap-2"><p className="text-sm font-medium">{label}</p><Separator /><p className="text-sm text-muted-foreground">Review preferences</p></div>',
    },
    sheet: {
      label: 'Open project panel',
      imports: [
        ui('button', 'Button'),
        ui('sheet', `Sheet, SheetTrigger, SheetHeader, SheetTitle, SheetDescription${base === 'aria' ? '' : ', SheetContent'}`),
      ].join('\n'),
      markup: popup(
        { root: 'Sheet', trigger: 'SheetTrigger', content: 'SheetContent' },
        '<SheetHeader><SheetTitle>Project notes</SheetTitle><SheetDescription>Keep the outline and review links in one place.</SheetDescription></SheetHeader>',
      ),
      hydrate: true,
    },
    sidebar: sidebar(base),
    skeleton: {
      label: 'Loading project',
      imports: ui('skeleton', 'Skeleton'),
      markup:
        '<div role="status" aria-label={label} className="flex items-center gap-3"><Skeleton className="size-10 rounded-full" /><div className="grid gap-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-3 w-24" /></div></div>',
    },
    slider: {
      label: 'Zoom',
      imports: ui('slider', 'Slider'),
      markup: `<Slider aria-label={label} ${base === 'aria' ? 'defaultValue={50} maxValue={100}' : base === 'radix' ? 'defaultValue={[50]} max={100}' : 'defaultValue={50} max={100}'} step={1} />`,
      hydrate: true,
    },
    sonner: {
      label: 'Show notification',
      imports: `import { useId } from "react";
import { toast } from "sonner";
import { usePreviewDirection } from "../PreviewDirection";
${ui('button', 'Button')}
${ui('sonner', 'Toaster')}`,
      setup: 'const toasterId = useId();\n  const direction = usePreviewDirection();',
      markup:
        '<><Button variant="outline" onClick={() => toast.success("Project saved", { toasterId })}>{label}</Button><Toaster id={toasterId} dir={direction} /></>',
      hydrate: true,
    },
    spinner: {
      label: 'Saving project',
      imports: ui('spinner', 'Spinner'),
      markup: '<div className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />{label}</div>',
    },
    switch: {
      label: 'Send reminders',
      imports: fieldControl('switch', 'Switch'),
      setup: 'const identifier = useId();',
      markup: '<Field orientation="horizontal"><Switch id={identifier} /><FieldLabel htmlFor={identifier}>{label}</FieldLabel></Field>',
      hydrate: true,
    },
    table: {
      label: 'Project status',
      imports: tableImports(),
      markup:
        base === 'aria'
          ? '<figure><Table aria-label={label}><TableHeader><TableHead isRowHeader>Project</TableHead><TableHead>Status</TableHead></TableHeader><TableBody><TableRow><TableCell>Field notes</TableCell><TableCell>In review</TableCell></TableRow></TableBody></Table><TableCaption>{label}</TableCaption></figure>'
          : '<Table><TableCaption>{label}</TableCaption><TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>Field notes</TableCell><TableCell>In review</TableCell></TableRow></TableBody></Table>',
    },
    textarea: {
      label: 'Review notes',
      imports: fieldControl('textarea', 'Textarea'),
      setup: 'const identifier = useId();',
      markup: '<Field><FieldLabel htmlFor={identifier}>{label}</FieldLabel><Textarea id={identifier} placeholder="Add a note…" /></Field>',
    },
    toast: {
      label: 'Show toast',
      imports: `import { useState } from "react";
${ui('button', 'Button')}
${ui('toast', 'Toaster, createToastManager')}`,
      setup: 'const [toastManager] = useState(createToastManager);',
      markup:
        '<><Button variant="outline" onClick={() => toastManager.add({ title: "Project saved" })}>{label}</Button><Toaster toastManager={toastManager} /></>',
      hydrate: true,
    },
    toggle: {
      label: 'Bold',
      imports: ui('toggle', 'Toggle'),
      markup: '<Toggle variant="outline" aria-label={label}>{label}</Toggle>',
      hydrate: true,
    },
    'toggle-group': {
      label: 'Text formatting',
      imports: ui('toggle-group', 'ToggleGroup, ToggleGroupItem'),
      markup: `<ToggleGroup aria-label={label} variant="outline" ${base === 'aria' ? 'selectionMode="multiple"' : base === 'radix' ? 'type="multiple"' : 'multiple'}>
        <ToggleGroupItem ${itemProperty}="bold">Bold</ToggleGroupItem><ToggleGroupItem ${itemProperty}="italic">Italic</ToggleGroupItem>
      </ToggleGroup>`,
      hydrate: true,
    },
    tooltip: {
      label: 'Project help',
      imports: [ui('button', 'Button'), ui('tooltip', `Tooltip, TooltipTrigger${base === 'aria' ? '' : ', TooltipContent, TooltipProvider'}`)].join('\n'),
      markup:
        base === 'aria'
          ? popup({ root: 'Tooltip', trigger: 'TooltipTrigger', content: 'Tooltip' }, 'See how project reviews work.')
          : `<TooltipProvider>${popup({ root: 'Tooltip', trigger: 'TooltipTrigger', content: 'TooltipContent' }, 'See how project reviews work.')}</TooltipProvider>`,
      hydrate: true,
    },
    trace: {
      label: 'Checked the project files',
      imports: ui('trace', 'Trace, TraceLine, TraceTitle, TraceDescription'),
      markup:
        '<Trace><TraceLine><TraceTitle>{label}</TraceTitle><TraceDescription>Configuration and component paths passed.</TraceDescription></TraceLine></Trace>',
    },
    'data-table': dataTable(base),
    'date-picker': datePicker(base, popup),
    typography: {
      label: 'Project notes',
      imports: '',
      markup:
        '<article className="grid gap-3 text-foreground"><h2 className="scroll-m-20 text-2xl font-semibold tracking-tight">{label}</h2><p className="text-sm leading-6 text-muted-foreground">Use the activity log to follow reviews and decisions.</p><blockquote className="border-s-2 ps-4 text-sm italic">Keep the next action visible.</blockquote></article>',
    },
  } satisfies Readonly<Record<string, CatalogExample>>;
}

function ui(item: string, names: string): string {
  return `import { ${names} } from "../../ui/${item}";`;
}

function fieldControl(item: string, names: string): string {
  return `import { useId } from "react";
${ui(item, names)}
${ui('field', 'Field, FieldLabel')}`;
}

function buttonTrigger(trigger: string, base: Exclude<ShadcnBase, 'aria'>, contents: string): string {
  switch (base) {
    case 'base':
      return `<${trigger} render={<Button variant="outline" />}>${contents}</${trigger}>`;
    case 'radix':
      return `<${trigger} asChild><Button variant="outline">${contents}</Button></${trigger}>`;
  }
}

function popoverImports(base: ShadcnBase): string {
  return [
    ui('button', 'Button'),
    ui('popover', `Popover, PopoverTrigger, PopoverHeader, PopoverTitle, PopoverDescription${base === 'aria' ? '' : ', PopoverContent'}`),
  ].join('\n');
}

function tableImports(): string {
  return ui('table', 'Table, TableCaption, TableHeader, TableBody, TableHead, TableRow, TableCell');
}

function selectExample(base: ShadcnBase): CatalogExample {
  const placeholder = base === 'aria' ? ' placeholder={label}' : '';
  const items = base === 'base' ? ' items={[{ value: null, label }, ...statuses]}' : '';
  const value = base === 'radix' ? ' placeholder={label}' : '';
  const itemProperty = base === 'aria' ? 'id' : 'value';
  return {
    label: 'Select a status',
    imports: ui('select', 'Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem'),
    module: 'const statuses = [{ value: "draft", label: "Draft" }, { value: "review", label: "In review" }, { value: "done", label: "Complete" }];',
    markup: `<Select${placeholder}${items}><SelectTrigger aria-label={label}><SelectValue${value} /></SelectTrigger>
      <SelectContent><SelectGroup>{statuses.map((status) => <SelectItem key={status.value} ${itemProperty}={status.value}>{status.label}</SelectItem>)}</SelectGroup></SelectContent></Select>`,
    hydrate: true,
  };
}

function sidebar(base: ShadcnBase): CatalogExample {
  return {
    label: 'Project navigation',
    imports: ui(
      'sidebar',
      'Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarGroupContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarProvider',
    ),
    markup: `<SidebarProvider className="min-h-0 max-w-sm rounded-lg border"><Sidebar collapsible="none" className="rounded-lg">
      <SidebarContent style={{ scrollbarGutter: "stable" }}><SidebarGroup><SidebarGroupLabel>{label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
        <SidebarMenuItem>${base === 'base' ? '<SidebarMenuButton render={<a href="/" />}>Overview</SidebarMenuButton>' : base === 'radix' ? '<SidebarMenuButton asChild><a href="/">Overview</a></SidebarMenuButton>' : '<SidebarMenuButton href="/">Overview</SidebarMenuButton>'}</SidebarMenuItem>
      </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar></SidebarProvider>`,
    hydrate: true,
  };
}

function dataTable(base: ShadcnBase): CatalogExample {
  // React Aria expects columns in the header collection and a figcaption outside its grid.
  const aria = base === 'aria';
  const columns = `{group.headers.map((header) =>
          <TableHead key={header.id}${aria ? ' id={header.id} isRowHeader={header.column.id === "name"}' : ''}>
            {flexRender(header.column.columnDef.header, header.getContext())}
          </TableHead>)}`;
  const caption = '<TableCaption>{label}</TableCaption>';
  const header = aria
    ? `<TableHeader>{table.getHeaderGroups().map((group) => <Fragment key={group.id}>${columns}</Fragment>)}</TableHeader>`
    : `<TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>${columns}</TableRow>)}</TableHeader>`;
  return {
    label: 'Projects',
    imports: `${aria ? 'import { Fragment } from "react";\n' : ''}import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
${ui('button', 'Button')}
${tableImports()}`,
    module: `const projects = [{ name: "Field notes", status: "Review" }, { name: "Archive", status: "Done" }, { name: "Studio", status: "Draft" }];
const columns: ColumnDef<(typeof projects)[number]>[] = [
  { accessorKey: "name", header: ({ column }) => <Button variant="ghost" onClick={column.getToggleSortingHandler()}>Project ↕</Button> },
  { accessorKey: "status", header: "Status", enableSorting: false },
];`,
    setup: 'const table = useReactTable({ data: projects, columns, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });',
    markup: `${aria ? '<figure>' : ''}<Table aria-label={label}>${aria ? '' : caption}
      ${header}
      <TableBody>{table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) =>
        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody>
    </Table>${aria ? caption + '</figure>' : ''}`,
    hydrate: true,
  };
}

function datePicker(
  base: ShadcnBase,
  popup: (names: { readonly root: string; readonly trigger: string; readonly content: string }, contents: string) => string,
): CatalogExample {
  const aria = base === 'aria';
  const dateProps = aria ? 'value={date} onChange={setDate} aria-label="Review date"' : 'mode="single" selected={date} onSelect={setDate}';
  const dateType = aria ? 'DateValue | null' : 'Date | undefined';
  // React Aria returns a date value that can format its calendar date without converting through a time zone.
  const display = aria ? 'date?.toString()' : 'date?.toLocaleDateString(undefined, { dateStyle: "medium" })';
  const imports = aria ? 'import type { DateValue } from "react-aria-components";\n' : '';
  const calendar = aria ? 'Calendar<DateValue>' : 'Calendar';
  const trigger = popup({ root: 'Popover', trigger: 'PopoverTrigger', content: 'PopoverContent' }, `<${calendar} ${dateProps} />`);
  return {
    label: 'Pick a review date',
    imports: `import { useState } from "react";
${imports}${popoverImports(base).replace(', PopoverHeader, PopoverTitle, PopoverDescription', '')}
${ui('calendar', 'Calendar')}`,
    setup: `const [date, setDate] = useState<${dateType}>(${aria ? 'null' : 'undefined'});
  const triggerLabel = ${display} ?? label;`,
    markup: trigger.replace('{label}', '{triggerLabel}'),
    hydrate: true,
  };
}

function messageScroller(): CatalogExample {
  return {
    label: 'Project conversation',
    imports: [
      ui(
        'message-scroller',
        'MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton',
      ),
      ui('message', 'Message, MessageContent'),
      ui('bubble', 'Bubble, BubbleContent'),
    ].join('\n'),
    markup: `<MessageScrollerProvider><MessageScroller className="h-40 rounded-lg border" aria-label={label}>
      <MessageScrollerViewport style={{ scrollbarGutter: "stable" }}><MessageScrollerContent className="grid gap-2 p-3">
        {["I shared the outline.", "I added my comments.", "The last draft is ready.", "I will send the link today."].map((message) =>
          <MessageScrollerItem key={message}><Message><MessageContent><Bubble><BubbleContent>{message}</BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem>)}
      </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton />
    </MessageScroller></MessageScrollerProvider>`,
    hydrate: true,
  };
}

function questionnaire(): CatalogExample {
  return {
    label: 'Choose a review schedule',
    imports: `import { useState } from "react";
${ui('questionnaire', 'Questionnaire, QuestionnaireItem, QuestionnaireTitle, QuestionnaireChoices, QuestionnaireChoice, QuestionnaireActions, QuestionnaireSubmit')}`,
    setup: 'const [saved, setSaved] = useState(false);',
    markup: `<><Questionnaire defaultItem="schedule" items={[{ name: "schedule", required: true }]} onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
      <QuestionnaireItem name="schedule" required>
        <QuestionnaireTitle>{label}</QuestionnaireTitle><QuestionnaireChoices><QuestionnaireChoice value="weekly">Weekly</QuestionnaireChoice><QuestionnaireChoice value="monthly">Monthly</QuestionnaireChoice></QuestionnaireChoices>
      </QuestionnaireItem><QuestionnaireActions><QuestionnaireSubmit>Save schedule</QuestionnaireSubmit></QuestionnaireActions>
    </Questionnaire>{saved && <p role="status" className="mt-2 text-sm text-muted-foreground">Schedule saved for this preview.</p>}</>`,
    hydrate: true,
  };
}
