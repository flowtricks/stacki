// The "Inline styles" target: the selected element's `style` attribute, picked
// from its chip at the end of the selector well (SelectorPicker.tsx).
//
// A target kind beside the rule a chip names, not a special case inside it. The
// rest of the panel is unchanged: the resolved style folds the attribute's
// declarations in above every rule (resolveStyle's `inline` input), so with a
// rule picked its overridden values say so, and with the chip picked the
// attribute's values are the selected ones. What changes is where a write goes:
// with the chip picked the card's set, clear and add write the attribute.
//
// The attribute is a plain string (written whole, model/inlineTarget.ts), or an
// expression edited branch by branch (model/inlineBranches.ts): the CSS code section
// picks the branch and edits its text, and the panel's controls edit the same
// branch's declarations. An instance's style lives in its component file, and its
// edits are written there (model/componentStyleWrite.ts). An expression the
// conditional model cannot read is shown read-only, with the controls disabled.

import { useTranslate, useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import { readInlineStyle } from '../../../../shared/engine/inlineStyle';
import type { StyleDeclaration } from '../../../../shared/engine/intent';
import { findNode, getHost, onHostChange, type HostNode } from '../model/host';
import { writtenValue } from '../model/lengthUnit';
import { componentSource } from '../model/componentSourceCache';
import { componentStyleText, writeComponentStyle } from '../model/componentStyleWrite';
import { readStyleBranches, writeStyleBranch, type StyleBranch } from '../model/inlineBranches';
import {
  INLINE_STYLE_SELECTOR,
  chipInlineStyle,
  inlineChipShown,
  inlineDeclaration,
  inlineEditBase,
  inlineStyleOf,
  inlineStyleWrite,
  plainStyleBranch,
  plainStyleCommit,
  selectedBranch,
  type HeldInlineWrite,
  type InlineStyle,
} from '../model/inlineTarget';
import type { ElementSnapshot } from '../model/styleTypes';
import type { InlineResolveInput } from '../model/resolved';
import { usePseudoTarget } from './editorModel';
import type { LiveSetProp, SetProp } from './EditorBasics';
import type { InlineBranchView } from './InlineBranchEditor';
import type { StyleCardProps } from './QueryForms';

/** The chip as the well draws it. */
export interface InlineChip {
  /** `editable`: a plain declaration list; `code`: an expression (`{}` icon), edited by branch or read-only. */
  readonly state: 'editable' | 'code';
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onDeselect: () => void;
  /** Remove the attribute; undefined when the panel cannot. */
  readonly onClear: (() => void) | undefined;
}

/** What the CSS code section shows for the picked chip, in place of the rules. */
export type InlineCodeView =
  { readonly kind: 'branches'; readonly view: InlineBranchView } | { readonly kind: 'readonly'; readonly code: string; readonly reason: string };

/** The selected element's attribute, and whether its chip is the edit target. */
export function useInlineState() {
  const node = useSelectedHostNode();
  const attribute = node?.props?.['style'];
  // Read again only when the attribute itself changes, not on every host render.
  const ownStyle = useMemo(() => inlineStyleOf(attribute === undefined ? undefined : { props: { style: attribute } }), [attribute]);
  // The node the chip was picked on: another selection is never the target.
  const [pickedFor, setPickedFor] = useState<string | undefined>(undefined);
  // The branch edited, by its place in the chain; a missing key falls back to the first.
  const [branchKey, setBranchKey] = useState<string | undefined>(undefined);
  const nodeId = node?.id;
  const writable = getHost().setInlineStyle !== undefined;
  const pseudo = usePseudoTarget() !== undefined;
  // An instance renders its component's element, whose attribute its component writes.
  const instance = node?.kind === 'component';
  return { ownStyle, nodeId, pickedFor, setPickedFor, branchKey, setBranchKey, writable, pseudo, instance };
}

export type InlineState = ReturnType<typeof useInlineState>;

/**
 * The style the chip stands for: the node's own attribute, or, for an instance with
 * none, the one its component writes, read from the component file when it is held
 * (the canvas's rendered attribute says whether there is one at all).
 */
export function chipStyleOf(inline: Pick<InlineState, 'ownStyle' | 'instance'>, snapshot: ElementSnapshot | undefined): InlineStyle {
  const path = inline.instance ? getHost().selectedComponentPath : undefined;
  const text = path === undefined ? undefined : componentSource(path);
  return chipInlineStyle(inline.ownStyle, {
    instance: inline.instance,
    style: snapshot?.attributes['style'],
    component: path === undefined || text === undefined ? undefined : { path, text },
  });
}

/** Whether the chip is in the well, and whether it is the edit target. */
export function inlineTargetOf(inline: InlineState, style: InlineStyle): { readonly shown: boolean; readonly active: boolean } {
  const shown = inlineChipShown(style, { writable: inline.writable, pseudo: inline.pseudo });
  const active = shown && inline.nodeId !== undefined && inline.pickedFor === inline.nodeId;
  return { shown, active };
}

/** What resolveStyle folds in: the attribute's declarations, or the edited branch's. */
export function inlineResolveInput(input: {
  readonly style: InlineStyle;
  readonly active: boolean;
  readonly branchKey: string | undefined;
}): InlineResolveInput | undefined {
  const { style, active } = input;
  switch (style.kind) {
    case 'declarations':
      return { declarations: style.declarations, selected: active };
    case 'branched': {
      // A branch whose text is not a declaration list shows nothing in the controls.
      const declarations = readInlineStyle(selectedBranch(style, input.branchKey).body) ?? [];
      return { declarations, selected: active };
    }
    case 'none':
    case 'code':
      return undefined;
    default: {
      const exhaustive: never = style;
      return exhaustive;
    }
  }
}

/**
 * The card with the inline target applied: the chip in the well, picking a rule
 * leaving it, and, while it is picked, every write going to the attribute.
 */
export function useInlineCard(
  card: StyleCardProps,
  inline: InlineState,
  panel: { readonly deselect: () => void; readonly setSaveError: (message: string | undefined) => void },
): StyleCardProps {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { nodeId, setPickedFor, branchKey, setBranchKey } = inline;
  const { deselect, setSaveError } = panel;
  const style = chipStyleOf(inline, card.snapshot);
  const { shown, active } = inlineTargetOf(inline, style);
  const heldRef = useRef<HeldInlineWrite | undefined>(undefined);
  useForgetHeldWrite(heldRef, nodeId);
  const refuse = (message: string): void => setSaveError(message);

  // A plain string: the whole attribute's next text.
  const writeDeclarations = (properties: readonly string[], declaration: StyleDeclaration): void => {
    const host = getHost();
    if (nodeId === undefined || host.setInlineStyle === undefined) {
      return;
    }
    const hostText = attributeText(findNode(host.nodes, nodeId), 'string');
    const outcome = inlineStyleWrite(inlineEditBase(hostText, nodeId, heldRef.current), properties, declaration);
    if (outcome.tag === 'refused') {
      refuse(translateDescribed(outcome));
      return;
    }
    setSaveError(undefined);
    heldRef.current = { nodeId, base: hostText, next: outcome.next };
    host.setInlineStyle(nodeId, outcome.next === undefined ? undefined : { type: 'string', value: outcome.next });
  };

  // An expression: one branch's text replaced, then written where the expression lives.
  const writeBranch = (body: (branch: StyleBranch) => string | undefined): void => {
    if (style.kind !== 'branched' || nodeId === undefined) {
      return;
    }
    const current = currentExpression(style, nodeId, heldRef.current);
    const read = current === undefined ? undefined : readStyleBranches(current);
    if (current === undefined || read?.tag !== 'branches') {
      refuse(translate('styleModel.embed.inline.changedShape'));
      return;
    }
    const branch = read.branches.find((entry) => entry.key === selectedBranch(style, branchKey).key);
    const nextBody = branch === undefined ? undefined : body(branch);
    if (branch === undefined || nextBody === undefined) {
      return;
    }
    const written = writeStyleBranch(current, branch, nextBody);
    if (written.tag === 'refused') {
      refuse(translateDescribed(written));
      return;
    }
    setSaveError(undefined);
    writeExpression(style, nodeId, current, written.expression, heldRef, refuse);
  };
  const writeBranchDeclarations = (properties: readonly string[], declaration: StyleDeclaration): void => {
    writeBranch((branch) => {
      const outcome = inlineStyleWrite(branch.body, properties, declaration);
      if (outcome.tag === 'refused') {
        refuse(translateDescribed(outcome));
        return undefined;
      }
      return outcome.next ?? '';
    });
  };
  const write = style.kind === 'branched' ? writeBranchDeclarations : writeDeclarations;

  const select = (): void => {
    if (nodeId === undefined) {
      return;
    }
    // No rule is the target now: the panel shows the attribute's values over the cascade.
    deselect();
    setPickedFor(nodeId);
    // The attribute is shown and edited in the CSS code section, so it opens with the pick.
    if (!card.cssCodeOpen) {
      card.onToggleCssCode();
    }
  };
  const leave = (): void => setPickedFor(undefined);
  const clear = (): void => {
    const host = getHost();
    if (nodeId === undefined || host.setInlineStyle === undefined) {
      return;
    }
    heldRef.current = { nodeId, base: attributeText(findNode(host.nodes, nodeId), 'string'), next: undefined };
    setPickedFor(undefined);
    host.setInlineStyle(nodeId, undefined);
  };
  const chip: InlineChip | undefined = shown
    ? {
        state: style.kind === 'declarations' ? 'editable' : 'code',
        active,
        onSelect: select,
        onDeselect: leave,
        onClear: style.kind === 'declarations' ? clear : undefined,
      }
    : undefined;
  const withChip: StyleCardProps = {
    ...card,
    inline: chip,
    // Any rule picked, typed or deselected leaves the attribute.
    onSelectActive: (selector) => {
      leave();
      card.onSelectActive(selector);
    },
    onDeselect: () => {
      leave();
      card.onDeselect();
    },
    onAddSelector: (selector, placement) => {
      leave();
      card.onAddSelector(selector, placement);
    },
    // An override note naming the attribute picks its chip, as one naming a rule picks that rule.
    onSelectSelector: (selector, prop) => {
      if (selector === INLINE_STYLE_SELECTOR) {
        select();
        return;
      }
      leave();
      card.onSelectSelector(selector, prop);
    },
  };
  if (!active) {
    return withChip;
  }
  if (style.kind === 'code') {
    // Read-only, with why: the controls stay, disabled (StyleCard.tsx).
    return {
      ...withChip,
      inlineCode: { kind: 'readonly', code: style.code, reason: translateDescribed({ message: style.message, messageRef: style.messageRef }) },
      setProp: ignoreWrite,
      onAdd: ignoreWrite,
      liveSetProp: ignoreLive,
      clearProp: () => undefined,
    };
  }
  const setProp: SetProp = (prop, typed, important) => {
    const value = writtenValue(prop, typed);
    write([prop], value.trim() === '' ? { tag: 'remove' } : inlineDeclaration(value, { important }));
  };
  const writes = {
    setProp,
    onAdd: setProp,
    // The attribute has no live layer to scrub on the canvas: a field's live value
    // shows once it commits, and a cancelled one has nothing to put back.
    liveSetProp: ignoreLive,
    clearProp: (prop: string | string[]) => write(Array.isArray(prop) ? prop : [prop], { tag: 'remove' }),
  };
  if (style.kind === 'declarations') {
    // The whole list in the CSS code editor, written as the attribute's next text.
    const plain: InlineBranchView = {
      branches: [plainStyleBranch(style.text)],
      selected: plainStyleBranch(style.text),
      onSelect: () => undefined,
      onCommit: (body) => {
        const host = getHost();
        if (nodeId === undefined || host.setInlineStyle === undefined) {
          return;
        }
        const outcome = plainStyleCommit(body);
        if (outcome.tag === 'refused') {
          refuse(translateDescribed(outcome));
          return;
        }
        setSaveError(undefined);
        heldRef.current = { nodeId, base: attributeText(findNode(host.nodes, nodeId), 'string'), next: outcome.next };
        host.setInlineStyle(nodeId, outcome.next === undefined ? undefined : { type: 'string', value: outcome.next });
      },
      writesTo: undefined,
    };
    return { ...withChip, ...writes, sourceNote: undefined, inlineCode: { kind: 'branches', view: plain } };
  }
  if (style.kind !== 'branched') {
    // No attribute: never active (inlineTargetOf), so there is nothing to edit.
    return withChip;
  }
  const view: InlineBranchView = {
    branches: style.branches,
    selected: selectedBranch(style, branchKey),
    onSelect: setBranchKey,
    onCommit: (body) => writeBranch(() => body),
    writesTo: style.source.kind === 'component' ? translate('styleModel.embed.inline.writesTo', { file: style.source.fileName }) : undefined,
  };
  return { ...withChip, ...writes, inlineCode: { kind: 'branches', view } };
}

// The read-only target writes nothing.
const ignoreWrite: SetProp = () => undefined;
const ignoreLive: LiveSetProp = () => undefined;

// The expression as it stands: the node's attribute (or the write not yet in it),
// or the component file's, read fresh from the cache a write updates at once.
function currentExpression(style: Extract<InlineStyle, { kind: 'branched' }>, nodeId: string, held: HeldInlineWrite | undefined): string | undefined {
  const source = style.source;
  switch (source.kind) {
    case 'node': {
      const hostText = attributeText(findNode(getHost().nodes, nodeId), 'expr');
      return inlineEditBase(hostText, nodeId, held);
    }
    case 'component': {
      const text = componentSource(source.path) ?? source.text;
      const span = text.slice(source.start, source.end);
      // The file moved under the span: the cached style is stale until it is read again.
      return span === style.expression || text === source.text ? span : undefined;
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function writeExpression(
  style: Extract<InlineStyle, { kind: 'branched' }>,
  nodeId: string,
  current: string,
  next: string,
  heldRef: { current: HeldInlineWrite | undefined },
  refuse: (message: string) => void,
): void {
  const source = style.source;
  switch (source.kind) {
    case 'node': {
      const host = getHost();
      assert(host.setInlineStyle !== undefined, 'writeExpression: a node expression is shown only where the host writes');
      heldRef.current = { nodeId, base: attributeText(findNode(host.nodes, nodeId), 'expr'), next };
      host.setInlineStyle(nodeId, { type: 'expr', value: next });
      return;
    }
    case 'component': {
      const before = componentSource(source.path) ?? source.text;
      assert(before.slice(source.start, source.end) === current, 'writeExpression: the expression is where the file says');
      const after = componentStyleText({ text: before, start: source.start, end: source.end }, next);
      void writeComponentStyle(source.path, source.fileName, { before, after }).catch((error: unknown) => refuse(String(error)));
      return;
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function attributeText(node: HostNode | undefined, type: 'string' | 'expr'): string | undefined {
  const attribute = node?.props?.['style'];
  if (attribute?.type !== type) {
    return undefined;
  }
  return attribute.value;
}

// A held write belongs to one element; a new selection starts from the host.
function useForgetHeldWrite(heldRef: { current: HeldInlineWrite | undefined }, nodeId: string | undefined): void {
  useEffect(() => {
    if (heldRef.current !== undefined && heldRef.current.nodeId !== nodeId) {
      heldRef.current = undefined;
    }
  }, [heldRef, nodeId]);
}

// The selected node, followed through host changes.
function useSelectedHostNode(): HostNode | undefined {
  const [node, setNode] = useState<HostNode | undefined>(readSelectedNode);
  useEffect(() => {
    const sync = (): void => setNode(readSelectedNode());
    sync();
    return onHostChange(sync);
  }, []);
  return node;
}

function readSelectedNode(): HostNode | undefined {
  const host = getHost();
  return host.selectedId === undefined ? undefined : findNode(host.nodes, host.selectedId);
}
