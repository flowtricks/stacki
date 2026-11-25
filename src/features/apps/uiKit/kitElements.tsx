// The app UI kit's elements: Stacki's own React components, compiled into
// `__stacki/ui.js` by scripts/build/appUiKit.mts and served to apps
// (shared/properties/appUiKit.ts). Each custom element renders the editor's
// component, not a copy of it, so a change to Dropdown.tsx, Switch.tsx,
// SegmentedTabs.tsx, SearchField.tsx, ResetLabel.tsx or Tooltip.tsx, or to the
// CSS they import, reaches apps on the next build.
//
// Elements render into their light DOM (a `.stacki-ui` span), not a shadow root,
// and the editor's popups portal to a `.stacki-ui` layer at the end of the body
// (src/ui/popupLayer.ts): the kit's stylesheet, the editor's own sheets inside
// `@scope (.stacki-ui)`, styles both as the editor's styles them. Each element reflects its state to an
// attribute (`value`, `checked`) and fires `change` (or `reset`) when the person
// changes it; `input` events from fields bubble as they would from any input.
//
// What the author writes inside an element (a dropdown's options, the tabs, a
// button's text) is data, kept apart from the mount React renders into. It is
// read when the element connects and again whenever it changes, never once: a
// plain `<script src="__stacki/ui.js">` in `<head>` defines the elements before
// the parser has written their content, so content that arrives later is heard,
// and an author who refills an element (`replaceChildren`, `textContent`) gets
// the mount put back. The observer that hears it renders at most once per
// batch of changes and drops the records its own moves made.
//
// The entry also follows the editor's theme: `data-theme` on the app's root,
// from `stacki.ui.theme()` and each `theme.change`.
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import Dropdown, { type DropdownOption } from '../../../ui/Dropdown';
import { ResetLabel } from '../../../ui/ResetLabel';
import { SearchField } from '../../../ui/SearchField';
import { SegmentedTabs } from '../../../ui/SegmentedTabs';
import { Switch, SwitchRow } from '../../../ui/Switch';
import Tooltip from '../../../ui/Tooltip';
import {
  CheckIcon,
  CloseIcon,
  ElementComponentIcon,
  elementIcon,
  CopyIcon,
  ExternalIcon,
  GearIcon,
  HelpCircleIcon,
  MoreIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
  WarningTriangleIcon,
  FilterIcon,
} from '../../../ui/Icons';
import { KIT_MENU_ITEMS_MAX, KitMenu, type KitMenuEntry } from './KitMenu';
import { KitPopover } from './KitPopover';
import { KIT_CONFIRM_TONES, KitConfirm, type KitConfirmQuestion, type KitConfirmTone } from './KitConfirm';
import { POPUP_LAYER_ATTRIBUTE } from '../../../ui/popupLayer';
// The sheets the components rely on from the editor's main stylesheet.
import '../../../ui/controls.css';
import '../../../ui/dropdown.css';
import '../../../ui/resetLabel.css';

/** The most options a dropdown reads, and tabs a row reads; past it the rest are not listed. */
const OPTIONS_MAX = 500;
const TABS_MAX = 16;
/** An option's value or label set through the `options` property. */
const OPTION_TEXT_CHARS_MAX = 1000;
/**
 * Mutation records one batch is searched for a change of the author's content.
 * Past it the element renders again without looking further: refilling 500
 * options is one batch of about 1000 records.
 */
const MUTATION_RECORDS_MAX = 2048;
/** A confirm's title, message or button label, from an attribute or the helper's options. */
const CONFIRM_TEXT_CHARS_MAX = 2000;
/** The labels a confirm shows when the author names none: the editor's (ConfirmDialog.tsx). */
const CONFIRM_LABEL_DEFAULT = 'Continue';
const CANCEL_LABEL_DEFAULT = 'Cancel';
/** The class of the hidden span that holds a button's or reset label's own text. */
const CONTENT_CLASS = 'stacki-kit-content';

/**
 * The editor's icons an element can show by name (`icon="trash"`): a button's
 * glyph, a menu row's mark. A name outside this list shows no icon.
 */
const KIT_ICONS = {
  check: CheckIcon,
  close: CloseIcon,
  copy: CopyIcon,
  edit: PencilIcon,
  external: ExternalIcon,
  help: HelpCircleIcon,
  more: MoreIcon,
  pin: PinIcon,
  plus: PlusIcon,
  refresh: RefreshIcon,
  search: SearchIcon,
  settings: GearIcon,
  trash: TrashIcon,
  upload: UploadIcon,
  warning: WarningTriangleIcon,
  filter: FilterIcon,
} as const;
const KIT_ICON_PX = 16;

/** The longest icon value an option takes: a kit icon's name, `component` or `tag:<tag>`. */
const OPTION_ICON_CHARS_MAX = 64;
/** A tag the Navigator can name: letters first, then letters, digits and hyphens (custom elements). */
const TAG_NAME_PATTERN = /^[a-z][a-z0-9-]*$/i;
const TAG_ICON_PREFIX = 'tag:';

/**
 * A dropdown option's icon, as the Navigator draws it (StructureTree.tsx):
 * `component` is its component cube, `tag:<tag>` its icon for that element tag
 * (ElementIcons.tsx `elementIcon`, a custom element's icon for a tag it has no
 * icon of its own for), and any other name is one of the kit's icons. A value
 * none of these knows shows no icon. The size is Desktop's dropdown option icons'.
 */
function optionIcon(name: string | undefined): ReactNode {
  if (name === undefined) {
    return undefined;
  }
  assert(name.length <= OPTION_ICON_CHARS_MAX, 'An option icon was bounded when it was read');
  if (name === 'component') {
    return <ElementComponentIcon size={KIT_ICON_PX} />;
  }
  if (name.startsWith(TAG_ICON_PREFIX)) {
    const tag = name.slice(TAG_ICON_PREFIX.length);
    if (TAG_NAME_PATTERN.test(tag)) {
      return elementIcon(tag, KIT_ICON_PX);
    }
    return undefined;
  }
  return kitIcon(name);
}

function kitIcon(name: string | undefined): ReactNode {
  if (name === undefined || !Object.hasOwn(KIT_ICONS, name)) {
    return undefined;
  }
  const entry = Object.entries(KIT_ICONS).find(([key]) => key === name);
  assert(entry !== undefined, 'A known icon name has its icon');
  const Icon = entry[1];
  return <Icon size={KIT_ICON_PX} />;
}

/** One option as the `options` property takes and answers it. */
interface KitOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly group: string | undefined;
  /** `component`, `tag:<tag>` or a kit icon's name (optionIcon); an unknown one shows nothing. */
  readonly icon: string | undefined;
}

/** One custom element over one React root, rendered again on each attribute or content change. */
abstract class KitElement extends HTMLElement {
  private root: Root | undefined;
  private observer: MutationObserver | undefined;
  private scheduled = false;
  protected mount: HTMLElement | undefined;

  connectedCallback(): void {
    ensurePopupLayer();
    if (this.mount === undefined) {
      const mount = document.createElement('span');
      mount.className = 'stacki-ui stacki-kit-mount';
      this.mount = mount;
      this.root = createRoot(mount);
      this.mounted(mount);
      // The element's own content is data (options, tabs, a label). Only a change there re-renders: the
      // component's own DOM changes too, and hearing it would render forever.
      this.observer = new MutationObserver((records) => this.heard(records));
      this.observer.observe(this, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    this.update();
  }

  /** The mount was created and React's root listens on it (a field that filters its own events). */
  protected mounted(_mount: HTMLElement): void {}

  /** Moves what the author wrote where the element keeps it (a button's text into its hidden holder). */
  protected adopt(): void {}

  protected abstract view(): ReactNode;

  /** Renders the element now: the mount back in place, the author's content adopted, then the component. */
  protected update(): void {
    const mount = this.mount;
    const root = this.root;
    if (mount === undefined || root === undefined) {
      return; // Not yet connected: the first connect renders.
    }
    if (mount.parentNode !== this) {
      this.appendChild(mount); // Refilled by the author (`replaceChildren`, `textContent`): the component goes back.
    }
    this.adopt();
    // The moves just made are the element's own, not changes to hear.
    this.observer?.takeRecords();
    assert(mount.parentNode === this, 'The mount is a child of its element');
    root.render(this.view());
  }

  protected changed(kind: 'change' | 'input' | 'reset'): void {
    this.dispatchEvent(new Event(kind, { bubbles: true }));
  }

  protected attribute(name: string): string | undefined {
    return this.getAttribute(name) ?? undefined;
  }

  /** The author's own child nodes: everything but the mount. */
  protected authored(): readonly ChildNode[] {
    const mount = this.mount;
    return [...this.childNodes].filter((node) => node !== mount);
  }

  // One render per batch of changes, a microtask later, and only for a change outside the mount.
  private heard(records: readonly MutationRecord[]): void {
    if (!this.scheduled && this.authorChanged(records)) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.update();
      });
    }
  }

  private authorChanged(records: readonly MutationRecord[]): boolean {
    const mount = this.mount;
    if (mount === undefined) {
      return false;
    }
    if (records.length > MUTATION_RECORDS_MAX) {
      return true;
    }
    return records.some((record) => !mount.contains(record.target));
  }
}

/**
 * An element whose content is its label (a button, a reset label): the text the
 * author writes moves into a hidden holder, so it is read but drawn only once,
 * by the component.
 */
abstract class KitTextElement extends KitElement {
  protected override adopt(): void {
    const holder = this.holder();
    for (const node of this.authored()) {
      if (node !== holder) {
        holder.appendChild(node);
      }
    }
    assert(this.authored().length === 1, 'Only the holder is left beside the mount');
  }

  /** The label: the `label` attribute, else the text the author wrote. */
  protected text(): string {
    const label = this.attribute('label');
    if (label !== undefined) {
      return label;
    }
    return this.ownText();
  }

  /** The text the author wrote inside the element, without the `label` attribute. */
  protected ownText(): string {
    return (this.holder().textContent ?? '').trim();
  }

  private holder(): HTMLElement {
    const found = this.authored().find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains(CONTENT_CLASS));
    if (found !== undefined) {
      return found;
    }
    const holder = document.createElement('span');
    holder.className = CONTENT_CLASS;
    holder.hidden = true;
    if (this.mount === undefined) {
      this.appendChild(holder);
    } else {
      this.mount.before(holder);
    }
    assert(holder.parentNode === this, 'The holder is a child of its element');
    return holder;
  }
}

/**
 * `<stacki-dropdown value placeholder label searchable>` around `<option>`s and
 * `<optgroup>`s, or with its `options` property set: Dropdown.tsx. The options
 * are the element's children, never its rendered menu, so `replaceChildren`
 * with new options refills it. An option's `icon` (`<option icon>` or the
 * `icon` field) is drawn in its row and in the closed trigger: `component`,
 * `tag:<tag>` or a kit icon's name, as the Navigator draws them (optionIcon).
 * While the menu is open, `highlight` fires with `detail: { value }` each time
 * the row under the pointer or the arrow keys changes, and with
 * `detail: { value: undefined }` when the pointer leaves the rows or the menu
 * closes (Dropdown.tsx `onHighlight`).
 */
class StackiDropdown extends KitElement {
  private data: readonly KitOption[] | undefined;
  get value(): string {
    return this.getAttribute('value') ?? '';
  }
  set value(value: string) {
    this.setAttribute('value', String(value));
  }
  /** The options shown: the ones set here, else the child `<option>`s. */
  get options(): readonly KitOption[] {
    return this.data ?? this.childOptions();
  }
  /** Sets the options as data (strings, or `{ value, label?, disabled?, group?, icon? }`); `undefined` goes back to the children. */
  set options(input: unknown) {
    this.data = input === undefined || input === null ? undefined : parseKitOptions(input);
    this.update();
  }
  protected view(): ReactNode {
    const options: DropdownOption<string>[] = this.options.map((option) => ({
      value: option.value,
      label: option.label,
      disabled: option.disabled,
      ...(option.group === undefined ? {} : { group: option.group }),
      ...(option.icon === undefined ? {} : { icon: optionIcon(option.icon) }),
    }));
    assert(options.length <= OPTIONS_MAX, 'A dropdown lists a bounded number of options');
    const placeholder = this.attribute('placeholder');
    const label = this.attribute('label');
    return (
      <Dropdown
        value={this.value}
        options={options}
        disabled={this.hasAttribute('disabled')}
        searchable={this.hasAttribute('searchable')}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(label === undefined ? {} : { ariaLabel: label })}
        onChange={(value) => {
          this.setAttribute('value', value);
          this.changed('change');
        }}
        onHighlight={(value) => this.dispatchEvent(new CustomEvent('highlight', { bubbles: true, detail: { value } }))}
      />
    );
  }
  private childOptions(): readonly KitOption[] {
    const found = [...this.querySelectorAll<HTMLOptionElement>(':scope > option, :scope > optgroup > option')].slice(0, OPTIONS_MAX);
    return found.map((option) => ({
      value: option.value,
      label: option.label,
      disabled: option.disabled,
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : undefined,
      icon: childIcon(option.getAttribute('icon') ?? undefined),
    }));
  }
}

/** `<stacki-switch checked disabled label label-hidden>`: Switch.tsx, with its label beside it as the editor's switch rows draw it. */
class StackiSwitch extends KitElement {
  get checked(): boolean {
    return this.hasAttribute('checked');
  }
  // eslint-disable-next-line stacki/no-boolean-parameter -- A custom element's `checked` setter mirrors the platform's `HTMLInputElement.checked`.
  set checked(value: boolean) {
    this.toggleAttribute('checked', Boolean(value));
  }
  protected view(): ReactNode {
    const label = this.attribute('label') ?? '';
    const props = {
      label,
      checked: this.checked,
      disabled: this.hasAttribute('disabled'),
      onToggle: () => {
        this.checked = !this.checked;
        this.changed('change');
      },
    };
    // No label to show, or the author keeps it to the accessible name: the switch alone.
    if (label === '' || this.hasAttribute('label-hidden')) {
      return <Switch {...props} />;
    }
    return <SwitchRow {...props} />;
  }
}

/**
 * `<stacki-tabs value label fill>` around `<button value>` tabs: SegmentedTabs.tsx,
 * the sliding pill. Each tab is as wide as its label; `fill` stretches the row to
 * its container in equal shares, for a two-way switch across a panel.
 */
class StackiTabs extends KitElement {
  get value(): string {
    return this.getAttribute('value') ?? '';
  }
  set value(value: string) {
    this.setAttribute('value', String(value));
  }
  protected view(): ReactNode {
    const tabs = [...this.querySelectorAll<HTMLButtonElement>(':scope > button')]
      .slice(0, TABS_MAX)
      .map((button) => ({ value: button.value, label: (button.textContent ?? '').trim() }));
    if (tabs.length === 0) {
      return undefined;
    }
    const value = this.hasAttribute('value') ? this.value : (tabs[0]?.value ?? '');
    return (
      <SegmentedTabs
        tabs={tabs}
        value={value}
        label={this.attribute('label') ?? 'Tabs'} // i18n-ignore: default label of a UI-kit element that runs inside the app's own frame, which has no language provider; apps pass `label` to translate it.
        layout={this.hasAttribute('fill') ? 'equal' : 'content'}
        onPick={(picked) => {
          if (picked !== this.value) {
            this.setAttribute('value', picked);
            this.changed('change');
          }
        }}
      />
    );
  }
}

/**
 * `<stacki-search value label placeholder>`: SearchField.tsx. Every change of its
 * value (typing, the field's clear button, Escape) fires `input` and then
 * `change` from the element, once each; the field's own events stop at the mount
 * so none is heard twice.
 */
class StackiSearch extends KitElement {
  get value(): string {
    return this.getAttribute('value') ?? '';
  }
  set value(value: string) {
    this.setAttribute('value', String(value));
  }
  protected override mounted(mount: HTMLElement): void {
    // Added after createRoot, so React's own listener on the mount has already heard the event.
    for (const kind of ['input', 'change']) {
      mount.addEventListener(kind, (event) => event.stopPropagation());
    }
  }
  protected view(): ReactNode {
    const placeholder = this.attribute('placeholder');
    return (
      <SearchField
        label={this.attribute('label') ?? 'Search'} // i18n-ignore: default label of a UI-kit element that runs inside the app's own frame, which has no language provider; apps pass `label` to translate it.
        value={this.value}
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(value) => {
          if (value === this.value) {
            return;
          }
          this.setAttribute('value', value);
          this.changed('input');
          this.changed('change');
        }}
      />
    );
  }
}

/** `<stacki-input value placeholder type label>` and `<stacki-textarea>`: the editor's fields (controls.css). */
class StackiInput extends KitElement {
  get value(): string {
    return this.field()?.value ?? this.getAttribute('value') ?? '';
  }
  set value(value: string) {
    const field = this.field();
    if (field !== undefined) {
      field.value = String(value);
    }
    this.setAttribute('value', String(value));
  }
  protected field(): HTMLInputElement | HTMLTextAreaElement | undefined {
    return this.mount?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? undefined;
  }
  protected view(): ReactNode {
    return (
      <input
        type={this.attribute('type') ?? 'text'}
        defaultValue={this.attribute('value') ?? ''}
        placeholder={this.attribute('placeholder')}
        aria-label={this.attribute('label')}
        disabled={this.hasAttribute('disabled')}
      />
    );
  }
}
class StackiTextarea extends StackiInput {
  protected override view(): ReactNode {
    return (
      <textarea
        defaultValue={this.attribute('value') ?? ''}
        placeholder={this.attribute('placeholder')}
        aria-label={this.attribute('label')}
        rows={Number(this.attribute('rows') ?? '3')}
        disabled={this.hasAttribute('disabled')}
      />
    );
  }
}

/**
 * `<stacki-button variant="primary|ghost|danger" icon aria-label>Label</stacki-button>`: the editor's
 * buttons (controls.css). With an `icon` and no text it is an icon button, and its
 * accessible name is `aria-label`, else `label`; with text, `aria-label` overrides
 * the name the text gives.
 */
class StackiButton extends KitTextElement {
  /** A toggle button's state: `pressed` present and not `"false"`. */
  get pressed(): boolean {
    return this.hasAttribute('pressed') && this.getAttribute('pressed') !== 'false';
  }
  // eslint-disable-next-line stacki/no-boolean-parameter -- A toggle's `pressed` setter mirrors the platform's `aria-pressed` state, as `checked` does.
  set pressed(value: boolean) {
    this.setAttribute('pressed', value ? '' : 'false');
  }
  protected view(): ReactNode {
    const variant = this.attribute('variant');
    const icon = kitIcon(this.attribute('icon'));
    const ownText = this.ownText();
    const iconOnly = icon !== undefined && ownText === '';
    const name = this.attribute('aria-label') ?? (iconOnly ? this.attribute('label') : undefined);
    const classes = [variant, iconOnly ? 'stacki-kit-icon-button' : undefined].filter((part) => part !== undefined).join(' ');
    // A toggle button (`pressed`): its state in aria-pressed, flipped by a click, which fires `change`.
    const toggle = this.hasAttribute('pressed');
    return (
      <button
        type="button"
        className={classes === '' ? undefined : classes}
        aria-label={name}
        title={iconOnly ? name : undefined}
        aria-pressed={toggle ? this.pressed : undefined}
        disabled={this.hasAttribute('disabled')}
        onClick={
          toggle
            ? () => {
                this.pressed = !this.pressed;
                this.changed('change');
              }
            : undefined
        }
      >
        {icon}
        {iconOnly ? undefined : this.text()}
      </button>
    );
  }
}

/**
 * `<stacki-menu label icon>` around `<button value icon checked disabled danger>`
 * rows: a ⋯ button that opens the editor's menu (KitMenu.tsx). Choosing a row
 * fires `select` with `detail: { value }`. A row with `checked` (or
 * `checked="false"`) is a check row and shows its check at the end; a row
 * without it is an action.
 */
class StackiMenu extends KitElement {
  private data: readonly KitMenuEntry[] | undefined;
  /** The rows shown: the ones set here, else the child `<button>`s, `<hr>`s and `<header>`s. */
  get items(): readonly KitMenuEntry[] {
    return this.data ?? this.childItems();
  }
  /** Sets the rows as data (`{ value, label, … }`, `{ kind: 'separator' }`, `{ kind: 'heading', label }`); `undefined` goes back to the children. */
  set items(input: unknown) {
    this.data = input === undefined || input === null ? undefined : parseKitMenuEntries(input);
    this.update();
  }
  protected view(): ReactNode {
    const items = this.items;
    assert(items.length <= KIT_MENU_ITEMS_MAX, 'A menu lists a bounded number of rows');
    return (
      <KitMenu
        items={items}
        label={this.attribute('label') ?? 'Options'} // i18n-ignore: default label of a UI-kit element that runs inside the app's own frame, which has no language provider; apps pass `label` to translate it.
        icon={kitIcon(this.attribute('icon'))}
        disabled={this.hasAttribute('disabled') || !items.some((entry) => entry.kind === 'item')}
        onSelect={(value) => this.dispatchEvent(new CustomEvent('select', { bubbles: true, detail: { value } }))}
      />
    );
  }
  private childItems(): readonly KitMenuEntry[] {
    const children = [...this.querySelectorAll<HTMLElement>(':scope > button, :scope > hr, :scope > header')].slice(0, KIT_MENU_ITEMS_MAX);
    return children.map((child): KitMenuEntry => {
      if (child instanceof HTMLHRElement) {
        return { kind: 'separator' };
      }
      if (child instanceof HTMLButtonElement) {
        return {
          kind: 'item',
          value: child.value,
          label: (child.textContent ?? '').trim(),
          icon: kitIcon(child.getAttribute('icon') ?? undefined),
          shortcut: child.getAttribute('shortcut') ?? undefined,
          checked: child.hasAttribute('checked') ? child.getAttribute('checked') !== 'false' : undefined,
          disabled: child.disabled,
          danger: child.hasAttribute('danger'),
        };
      }
      return { kind: 'heading', label: (child.textContent ?? '').trim() };
    });
  }
}

/**
 * `<stacki-popover label icon open disabled>` around the app's own markup: a
 * button that opens that markup in the editor's popover beside it
 * (KitPopover.tsx). `open` reflects the state; every open and close fires
 * `toggle` with `detail: { open }`.
 */
class StackiPopover extends KitElement {
  private panelBody: HTMLElement | undefined;
  get open(): boolean {
    return this.hasAttribute('open');
  }
  // eslint-disable-next-line stacki/no-boolean-parameter -- Mirrors the platform's `HTMLDetailsElement.open`.
  set open(value: boolean) {
    this.toggleAttribute('open', Boolean(value));
  }
  protected override adopt(): void {
    const body = this.bodyNode();
    // What the author writes in the element joins the body, wherever the body is now (here, or in the popup).
    for (const node of this.authored()) {
      if (node !== body) {
        body.appendChild(node);
      }
    }
    assert(
      this.authored().every((node) => node === body),
      'Only the body is left beside the mount',
    );
  }
  protected view(): ReactNode {
    const body = this.bodyNode();
    return (
      <KitPopover
        open={this.open}
        label={this.attribute('label') ?? 'Options'} // i18n-ignore: default label of a UI-kit element that runs inside the app's own frame, which has no language provider; apps pass `label` to translate it.
        icon={kitIcon(this.attribute('icon'))}
        disabled={this.hasAttribute('disabled')}
        body={body}
        restore={this.restore}
        onToggle={(open) => {
          if (open !== this.open) {
            this.open = open;
            this.dispatchEvent(new CustomEvent('toggle', { bubbles: true, detail: { open } }));
          }
        }}
      />
    );
  }
  private readonly restore = (body: HTMLElement): void => {
    if (this.mount === undefined) {
      this.appendChild(body);
    } else {
      this.mount.before(body);
    }
  };
  private bodyNode(): HTMLElement {
    if (this.panelBody === undefined) {
      const body = document.createElement('div');
      body.className = 'stacki-kit-popover-body';
      this.panelBody = body;
      this.restore(body);
    }
    return this.panelBody;
  }
}

/**
 * `<stacki-confirm title message confirm-label cancel-label tone>`: a question
 * asked inside the app (KitConfirm.tsx), never through the browser's
 * `confirm()`. The element draws nothing until `ask()` opens it; `ask({ anchor })`
 * opens it as a popover beside that control, else centred in the app's frame.
 * The answer is the promise's value, `true` for the confirm button and `false`
 * for Cancel, Escape or a click outside, and `close` fires with
 * `detail: { confirmed }`. The message is the `message` attribute, else the
 * element's text. `stackiConfirm(options)` asks without markup.
 */
class StackiConfirm extends KitTextElement {
  private asking: { readonly answer: Promise<boolean>; readonly anchor: HTMLElement | undefined; readonly resolve: (confirmed: boolean) => void } | undefined;
  /** Whether a question is open. */
  get open(): boolean {
    return this.asking !== undefined;
  }
  /** Opens the question, beside `anchor` when given; one question at a time, so asking again answers the open one's promise. */
  ask(options?: unknown): Promise<boolean> {
    const anchor = parseConfirmAnchor(options);
    if (this.asking !== undefined) {
      return this.asking.answer;
    }
    if (!this.isConnected) {
      return Promise.reject(new Error('stacki-confirm: add the element to the document before asking'));
    }
    let resolve: ((confirmed: boolean) => void) | undefined;
    const answer = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    assert(resolve !== undefined, 'A promise runs its executor at once');
    this.asking = { answer, anchor, resolve };
    this.toggleAttribute('open', true);
    this.update();
    assert(this.open, 'The question is open once asked');
    return answer;
  }
  disconnectedCallback(): void {
    // A question whose element left the page can never be answered by the person: it is a no.
    if (this.asking !== undefined) {
      this.settle({ confirmed: false });
    }
  }
  protected view(): ReactNode {
    const asking = this.asking;
    if (asking === undefined) {
      return undefined;
    }
    const question: KitConfirmQuestion = {
      heading: confirmText(this.attribute('title') ?? '', 'title'),
      message: confirmText(this.text(), 'message'),
      confirmLabel: confirmLabel(this.attribute('confirm-label'), CONFIRM_LABEL_DEFAULT, 'confirm-label'),
      cancelLabel: confirmLabel(this.attribute('cancel-label'), CANCEL_LABEL_DEFAULT, 'cancel-label'),
      tone: confirmTone(this.attribute('tone')),
      anchor: asking.anchor,
    };
    return <KitConfirm question={question} onAnswer={(confirmed) => this.settle({ confirmed })} />;
  }
  /** The message: the `message` attribute, else the element's text. */
  protected override text(): string {
    return this.attribute('message') ?? this.ownText();
  }
  private settle({ confirmed }: { readonly confirmed: boolean }): void {
    const asking = this.asking;
    assert(asking !== undefined, 'Only an open question is answered');
    this.asking = undefined;
    this.removeAttribute('open');
    this.update();
    assert(!this.open, 'An answered question is closed');
    asking.resolve(confirmed);
    this.dispatchEvent(new CustomEvent('close', { detail: { confirmed } }));
  }
}

/** `<stacki-reset-label active>Opacity</stacki-reset-label>`: ResetLabel.tsx, the blue label whose click offers Reset. */
class StackiResetLabel extends KitTextElement {
  protected view(): ReactNode {
    return <ResetLabel label={this.text()} active={this.hasAttribute('active')} onReset={() => this.changed('reset')} />;
  }
}

/**
 * `<stacki-tooltip text="…">`: Tooltip.tsx, the text with its full version on hover.
 *
 * Tooltip.tsx closes on mouseleave alone, which an app's re-rendered list never
 * sends: the row is removed under the pointer and the popup stays. So the kit
 * closes it too, by remounting the tooltip (a new `key`, so its state starts
 * idle and its popup goes at once): when the element leaves the page, when its
 * text or attributes change, and on any press, click, scroll, wheel, Escape,
 * window blur or tab switch (dismissOpenTooltip). One kit tooltip is open at a
 * time: hovering another closes the first.
 */
class StackiTooltip extends KitElement {
  /** Bumped to close the tooltip: a new key remounts it idle. Bounded by Number.MAX_SAFE_INTEGER, far past any session's closes. */
  private generation = 0;
  override connectedCallback(): void {
    listenForTooltipDismissal();
    if (this.mount === undefined) {
      this.addEventListener('mouseover', () => this.opened());
    }
    super.connectedCallback();
  }
  disconnectedCallback(): void {
    // Rendering while disconnected draws nothing (view), so the popup leaves with the element.
    this.close();
    this.update();
    assert(tooltipShown.current !== this, 'A removed tooltip is not the open one');
  }
  /** Closes the popup and draws the change: the next hover opens it again. */
  dismiss(): void {
    this.close();
    this.update();
  }
  private close(): void {
    if (tooltipShown.current === this) {
      tooltipShown.current = undefined;
    }
    assert(this.generation < Number.MAX_SAFE_INTEGER, 'Tooltip closes stay countable');
    this.generation += 1;
  }
  protected override update(): void {
    // A change to the anchor's text or attributes closes what it showed before rendering anew.
    this.close();
    super.update();
  }
  protected view(): ReactNode {
    if (!this.isConnected) {
      return undefined;
    }
    return <Tooltip key={this.generation} text={this.attribute('text') ?? ''} />;
  }
  // The pointer reached this tooltip: it is the open one, and the one open before closes.
  private opened(): void {
    if (tooltipShown.current === this) {
      return;
    }
    const previous = tooltipShown.current;
    tooltipShown.current = this;
    previous?.dismiss();
    assert(tooltipShown.current === this, 'The hovered tooltip is the open one');
  }
}

/** The kit tooltip whose popup may be showing; at most one. */
const tooltipShown: { current: StackiTooltip | undefined } = { current: undefined };
let tooltipDismissalHeard = false;

/** Closes the open kit tooltip, if any: a press, scroll, Escape or leaving the window ends a hover. */
function dismissOpenTooltip(): void {
  const open = tooltipShown.current;
  if (open === undefined) {
    return;
  }
  open.dismiss();
  assert(tooltipShown.current === undefined, 'A dismissed tooltip is closed');
}

// Added once, for every tooltip on the page: the window-wide events that end a hover.
function listenForTooltipDismissal(): void {
  if (tooltipDismissalHeard) {
    return;
  }
  tooltipDismissalHeard = true;
  const options = { capture: true, passive: true } as const;
  for (const kind of ['pointerdown', 'click', 'scroll', 'wheel']) {
    document.addEventListener(kind, dismissOpenTooltip, options);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      dismissOpenTooltip();
    }
  });
  document.addEventListener('visibilitychange', dismissOpenTooltip);
  window.addEventListener('blur', dismissOpenTooltip);
}

/**
 * The `options` property's input: an array of up to OPTIONS_MAX strings or
 * `{ value, label?, disabled?, group?, icon? }` objects. Anything else throws, naming
 * the entry, at the app's own assignment.
 */
function parseKitOptions(input: unknown): readonly KitOption[] {
  if (!Array.isArray(input)) {
    throw new TypeError('stacki-dropdown options: expected an array');
  }
  if (input.length > OPTIONS_MAX) {
    throw new RangeError(`stacki-dropdown options: at most ${OPTIONS_MAX}`);
  }
  const options = input.map((entry: unknown, index): KitOption => {
    if (typeof entry === 'string') {
      const value = optionText(entry, `options[${index}]`);
      return { value, label: value, disabled: false, group: undefined, icon: undefined };
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`stacki-dropdown options[${index}]: expected a string or an object`);
    }
    const fields = new Map<string, unknown>(Object.entries(entry));
    const value = optionText(fields.get('value'), `options[${index}].value`);
    const label = fields.get('label');
    const disabled = fields.get('disabled');
    const group = fields.get('group');
    const icon = fields.get('icon');
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      throw new TypeError(`stacki-dropdown options[${index}].disabled: expected a boolean`);
    }
    return {
      value,
      label: label === undefined ? value : optionText(label, `options[${index}].label`),
      disabled: disabled === true,
      group: group === undefined ? undefined : optionText(group, `options[${index}].group`),
      icon: icon === undefined ? undefined : optionIconText(icon, `options[${index}].icon`),
    };
  });
  assert(options.length === input.length, 'Every entry is one option');
  return options;
}

/**
 * The `items` property's input: up to KIT_MENU_ITEMS_MAX rows, each
 * `{ value, label, icon?, shortcut?, checked?, disabled?, danger? }`, a
 * `{ kind: 'separator' }` or a `{ kind: 'heading', label }`. Anything else
 * throws, naming the entry.
 */
function parseKitMenuEntries(input: unknown): readonly KitMenuEntry[] {
  if (!Array.isArray(input)) {
    throw new TypeError('stacki-menu items: expected an array');
  }
  if (input.length > KIT_MENU_ITEMS_MAX) {
    throw new RangeError(`stacki-menu items: at most ${KIT_MENU_ITEMS_MAX}`);
  }
  const entries = input.map((entry: unknown, index): KitMenuEntry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`stacki-menu items[${index}]: expected an object`);
    }
    const fields = new Map<string, unknown>(Object.entries(entry));
    const kind = fields.get('kind');
    const where = `items[${index}]`;
    if (kind === 'separator') {
      return { kind: 'separator' };
    }
    if (kind === 'heading') {
      return { kind: 'heading', label: menuText(fields.get('label'), `${where}.label`) };
    }
    if (kind !== undefined && kind !== 'item') {
      throw new TypeError(`stacki-menu ${where}.kind: expected 'item', 'separator' or 'heading'`);
    }
    const flag = (name: string): boolean => {
      const value = fields.get(name);
      if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError(`stacki-menu ${where}.${name}: expected a boolean`);
      }
      return value === true;
    };
    const checked = fields.get('checked');
    const icon = fields.get('icon');
    const shortcut = fields.get('shortcut');
    return {
      kind: 'item',
      value: menuText(fields.get('value'), `${where}.value`),
      label: menuText(fields.get('label'), `${where}.label`),
      icon: icon === undefined ? undefined : kitIcon(menuText(icon, `${where}.icon`)),
      shortcut: shortcut === undefined ? undefined : menuText(shortcut, `${where}.shortcut`),
      checked: checked === undefined ? undefined : flag('checked'),
      disabled: flag('disabled'),
      danger: flag('danger'),
    };
  });
  assert(entries.length === input.length, 'Every entry is one row');
  return entries;
}

function menuText(input: unknown, what: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`stacki-menu ${what}: expected a string`);
  }
  if (input.length > OPTION_TEXT_CHARS_MAX) {
    throw new RangeError(`stacki-menu ${what}: at most ${OPTION_TEXT_CHARS_MAX} characters`);
  }
  return input;
}

function optionIconText(input: unknown, what: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`stacki-dropdown ${what}: expected a string`);
  }
  if (input.length > OPTION_ICON_CHARS_MAX) {
    throw new RangeError(`stacki-dropdown ${what}: at most ${OPTION_ICON_CHARS_MAX} characters`);
  }
  return input;
}

// An `<option icon>` is markup, not a call: one past the bound is dropped rather than thrown.
function childIcon(input: string | undefined): string | undefined {
  if (input === undefined || input.length > OPTION_ICON_CHARS_MAX) {
    return undefined;
  }
  return input;
}

function optionText(input: unknown, what: string): string {
  if (typeof input !== 'string') {
    throw new TypeError(`stacki-dropdown ${what}: expected a string`);
  }
  if (input.length > OPTION_TEXT_CHARS_MAX) {
    throw new RangeError(`stacki-dropdown ${what}: at most ${OPTION_TEXT_CHARS_MAX} characters`);
  }
  return input;
}

/**
 * The `ask()` option: `{ anchor }`, an element in the page, or nothing. Anything
 * else throws at the app's own call.
 */
function parseConfirmAnchor(input: unknown): HTMLElement | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== 'object') {
    throw new TypeError('stacki-confirm ask: expected { anchor } or nothing');
  }
  const anchor: unknown = Reflect.get(input, 'anchor');
  if (anchor === undefined || anchor === null) {
    return undefined;
  }
  if (!(anchor instanceof HTMLElement)) {
    throw new TypeError('stacki-confirm anchor: expected an element');
  }
  return focusableIn(anchor);
}

// The control focus goes back to: the anchor itself when it takes focus, else the
// first control inside it (a kit element's own button).
function focusableIn(anchor: HTMLElement): HTMLElement {
  if (anchor.tabIndex >= 0) {
    return anchor;
  }
  const inner = anchor.querySelector<HTMLElement>('button, a[href], input, textarea, [tabindex]');
  return inner ?? anchor;
}

/**
 * `stackiConfirm(options)`'s input: `{ title?, message?, confirmLabel?,
 * cancelLabel?, tone?, anchor? }`, each text a string within
 * CONFIRM_TEXT_CHARS_MAX and `tone` 'default' or 'danger'. Anything else throws.
 */
function parseConfirmOptions(input: unknown): {
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  readonly anchor: HTMLElement | undefined;
} {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('stackiConfirm: expected an options object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  const attributes: Array<readonly [string, string]> = [];
  const names = [
    ['title', 'title'],
    ['message', 'message'],
    ['confirmLabel', 'confirm-label'],
    ['cancelLabel', 'cancel-label'],
    ['tone', 'tone'],
  ] as const;
  for (const [option, attribute] of names) {
    const value = fields.get(option);
    if (value !== undefined) {
      if (typeof value !== 'string') {
        throw new TypeError(`stackiConfirm ${option}: expected a string`);
      }
      attributes.push([attribute, confirmText(value, option)]);
    }
  }
  const tone = fields.get('tone');
  if (tone !== undefined) {
    confirmTone(typeof tone === 'string' ? tone : undefined);
  }
  assert(attributes.length <= names.length, 'Each option is one attribute');
  return { attributes, anchor: parseConfirmAnchor({ anchor: fields.get('anchor') }) };
}

function confirmText(input: string, what: string): string {
  if (input.length > CONFIRM_TEXT_CHARS_MAX) {
    throw new RangeError(`stacki-confirm ${what}: at most ${CONFIRM_TEXT_CHARS_MAX} characters`);
  }
  return input;
}

function confirmLabel(input: string | undefined, fallback: string, what: string): string {
  const label = confirmText(input ?? '', what).trim();
  return label === '' ? fallback : label;
}

function confirmTone(input: string | undefined): KitConfirmTone {
  if (input === undefined || input === '') {
    return 'default';
  }
  const tone = KIT_CONFIRM_TONES.find((candidate) => candidate === input);
  if (tone === undefined) {
    throw new TypeError(`stacki-confirm tone: expected ${KIT_CONFIRM_TONES.join(' or ')}`);
  }
  return tone;
}

/**
 * `stackiConfirm({ title, message, confirmLabel, cancelLabel, tone, anchor })`:
 * asks once, through a `<stacki-confirm>` added for the question and removed
 * when it is answered. Resolves `true` or `false`.
 */
function stackiConfirm(options: unknown): Promise<boolean> {
  const { attributes, anchor } = parseConfirmOptions(options);
  const element = document.createElement('stacki-confirm');
  assert(element instanceof StackiConfirm, 'stacki-confirm is defined before the helper asks');
  for (const [name, value] of attributes) {
    element.setAttribute(name, value);
  }
  document.body.appendChild(element);
  const answer = element.ask(anchor === undefined ? undefined : { anchor });
  return answer.finally(() => element.remove());
}

// The layer the editor's popups portal to (src/ui/popupLayer.ts), inside the kit's scope, so a dropdown's
// menu or the reset menu is styled as it is in the editor. Added once, at the end of the body.
function ensurePopupLayer(): void {
  if (document.querySelector(`[${POPUP_LAYER_ATTRIBUTE}]`) !== null) {
    return;
  }
  const layer = document.createElement('div');
  layer.className = 'stacki-ui stacki-kit-layer';
  layer.setAttribute(POPUP_LAYER_ATTRIBUTE, '');
  document.body.appendChild(layer);
}

const ELEMENTS: ReadonlyArray<readonly [string, CustomElementConstructor]> = [
  ['stacki-dropdown', StackiDropdown],
  ['stacki-switch', StackiSwitch],
  ['stacki-tabs', StackiTabs],
  ['stacki-search', StackiSearch],
  ['stacki-input', StackiInput],
  ['stacki-textarea', StackiTextarea],
  ['stacki-button', StackiButton],
  ['stacki-menu', StackiMenu],
  ['stacki-popover', StackiPopover],
  ['stacki-confirm', StackiConfirm],
  ['stacki-reset-label', StackiResetLabel],
  ['stacki-tooltip', StackiTooltip],
];

for (const [name, element] of ELEMENTS) {
  if (customElements.get(name) === undefined) {
    customElements.define(name, element);
  }
}

// The helper, after the elements it builds on are defined. An app never needs the browser's
// alert(), confirm() or prompt(): they block the editor's window and look like none of Stacki.
if (Reflect.get(window, 'stackiConfirm') === undefined) {
  Reflect.set(window, 'stackiConfirm', stackiConfirm);
}

// The editor's theme, on the document root as data-theme (the tokens key on it).
interface ThemeHost {
  readonly ui: { readonly theme: () => Promise<unknown> };
  readonly on: (event: string, listener: (data: unknown) => void) => unknown;
}
function applyTheme(view: unknown): void {
  if (typeof view === 'object' && view !== null && 'theme' in view && typeof view.theme === 'string') {
    document.documentElement.setAttribute('data-theme', view.theme);
  }
}
function themeHost(candidate: unknown): ThemeHost | undefined {
  if (typeof candidate !== 'object' || candidate === null || !('ui' in candidate) || !('on' in candidate)) {
    return undefined;
  }
  const { ui, on } = candidate;
  if (typeof ui !== 'object' || ui === null || !('theme' in ui) || typeof ui.theme !== 'function' || typeof on !== 'function') {
    return undefined;
  }
  const theme = ui.theme;
  return {
    ui: {
      theme: () => {
        const answer: unknown = theme.call(ui);
        return Promise.resolve(answer);
      },
    },
    on: (event, listener) => {
      const stop: unknown = on.call(candidate, event, listener);
      return stop;
    },
  };
}
const host = themeHost(Reflect.get(window, 'stacki'));
if (host !== undefined) {
  void host.ui.theme().then(applyTheme, () => undefined);
  host.on('theme.change', applyTheme);
}
