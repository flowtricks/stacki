// Editing a rule: splitting a shared rule before an edit, applying an edit
// through the class gate, prop edits, live edits, rule actions, opening an
// embed, and the selected element's tokens (EmbedEditor.tsx).

import { useTranslate, useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { snapshotTokens } from '../model/elementTokens';
import { groupMemberToSplit } from '../model/resolved';
import type { Declaration } from 'postcss';
import { addDeclaration, appendDecl, directDecls, removeRule, removeRuleIfEmpty, replaceRuleCss, splitRuleSelectorAt } from '../model/css';
import { parseSelectorList } from '../model/selectors';
import { clearPaddingSides, isPaddingProperty, setPaddingDeclaration } from '../model/spacingShorthand';
import { getHost, type ClassOutcome } from '../model/host';
import { liveRules, liveRuleTargetOf, type LiveRulePreview } from '../model/liveRuleEdits';
import type { LiveRuleEdit, LiveRuleTarget } from '../../../../shared/properties/liveRules';
import { selectedComponentMarkup, selectedInstanceClasses } from '../model/webflowElement';
import { type EmbedDocument, navigateToEmbed, writeEmbedDocument } from '../model/webflow';
import type { ParsedDeclaration, ParsedRule } from '../model/styleTypes';
import { declsFor, lastDeclFor, editorSession, withoutClasses } from './editorModel';
import { type SelectorSuggestion } from './LayoutRows';
import { useEditorRefs, useBusyState, useScanState, useNativeState, usePendingWrites } from './useEditorFoundation';
import { useRefreshDerived } from './useEditorScanning';

// Scope an edit of a grouped rule to the active selector alone.
export function useSplitForEdit(nativeState: ReturnType<typeof useNativeState>) {
  const { activeSelectorRef } = nativeState;

  // True when the active selector is ONE member of a grouped rule to edit on its own
  // (`.a::before, .b::after { … }`) — i.e. an edit should be scoped to just that
  // selector rather than the whole comma-separated group. Complex grouped
  // selectors (shown as a single full-group chip) don't match any lone member and
  // so return false — they edit the whole rule.
  const isGroupedSplittable = useCallback(
    (rule: ParsedRule): boolean => groupMemberToSplit(rule, activeSelectorRef.current) !== undefined,
    [activeSelectorRef],
  );
  // Isolate the active selector out of a grouped rule before editing so the change
  // only affects the selected chip, leaving the group's other selectors untouched.
  // Returns the rule to edit (the isolated clone, or the original when there's
  // nothing to split) plus a remapper from an original decl to its clone
  // counterpart (declarations are cloned in the same order) for decl-addressed edits.
  const splitForEdit = useCallback(
    (
      rule: ParsedRule,
    ): {
      rule: ParsedRule;
      remap: (decl: ParsedDeclaration) => ParsedDeclaration;
    } => {
      const identity = { rule, remap: (declaration: ParsedDeclaration) => declaration };
      const index = groupMemberToSplit(rule, activeSelectorRef.current);
      if (index === undefined) {
        return identity;
      }
      const origNodes: Declaration[] = [];
      rule.node.walkDecls((declaration) => {
        origNodes.push(declaration);
      });
      const clone = splitRuleSelectorAt(rule.node, index);
      if (!clone) {
        return identity;
      }
      const cloneNodes: Declaration[] = [];
      clone.walkDecls((declaration) => {
        cloneNodes.push(declaration);
      });
      const editRule: ParsedRule = {
        ...rule,
        node: clone,
        selectorText: clone.selector,
        selectors: parseSelectorList(clone.selector),
        declarations: rule.declarations.map((declaration, i) => ({
          ...declaration,
          node: cloneNodes[i] ?? declaration.node,
        })),
      };
      const remap = (decl: ParsedDeclaration): ParsedDeclaration => {
        const i = origNodes.indexOf(decl.node);
        return i >= 0 ? (editRule.declarations[i] ?? decl) : decl;
      };
      return { rule: editRule, remap };
    },
    [activeSelectorRef],
  );
  return { isGroupedSplittable, splitForEdit };
}

// Apply an edit to an embed rule and persist it.
export function useApplyEdit(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { setBusyBoth, setSaveError } = busyState;
  const { setStatus } = scanState;
  const { documentByKey, settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;

  // Classes typed into the selector box whose page edit has not answered yet,
  // by selector: the rule for one is written only once its class is on the
  // element (step 6, plan §3.3 — the dependent write is outcome-gated).
  const classGatesRef = useRef(new Map<string, Promise<ClassOutcome>>());

  // A rule for a class typed into the selector box waits for that class's page edit.
  // Never submitted when refused: a rule for a class the element does not carry would
  // be half a gesture. The page's own notice says why its edit failed.
  const passesClassGate = useCallback(
    async (rule: ParsedRule): Promise<boolean> => {
      const gate = classGatesRef.current.get(rule.selectorText);
      if (!gate) {
        return true;
      }
      const outcome = await gate;
      classGatesRef.current.delete(rule.selectorText);
      if (outcome.tag !== 'refused') {
        return true;
      }
      setSaveError(translate('styleModel.embed.hook.classNotOnElement', { selector: rule.selectorText, reason: translateDescribed(outcome) }));
      return false;
    },
    [setSaveError, translate, translateDescribed],
  );

  // Run a synchronous AST mutation, refresh the model, then persist the embed.
  // Resolves whether the write landed, so a canvas preview of the edit knows to
  // wait for the page or to put the page's own value back.
  const applyEdit = useCallback(
    async (rule: ParsedRule, mutate: () => boolean | void): Promise<boolean> => {
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        setStatus('Lost track of the source embed — try Rescan.'); // i18n-ignore: write-only status, never rendered.
        return false;
      }
      if (!(await passesClassGate(rule))) {
        return false;
      }
      setBusyBoth(true);
      setStatus('Saving…'); // i18n-ignore: write-only status, never rendered.
      // try/finally so `busy` ALWAYS clears — a throw here (e.g. materializing a complex
      // nested selector) must not leave the panel stuck busy, which disables every button.
      try {
        const result = mutate();
        if (result === false) {
          setStatus('Nothing to save.'); // i18n-ignore: write-only status, never rendered.
          return false;
        }
        // Persist FIRST, then rebuild the panel's own model. The write is what the canvas
        // sees, and refreshDerived re-resolves every rule against the element — running it
        // first put a full model rebuild (and, for a <style> node, the page save behind it)
        // between the click and the canvas, so the edit showed up seconds late.
        const writeResult = await writeEmbedDocument(embedDocument);
        await refreshDerived();
        if (!settleEmbedWrite(embedDocument, writeResult, 'rule')) {
          return false;
        }
        setStatus(rule.fromComponent ? 'Saved. This embed is shared by every instance of ' + `${rule.componentName ?? 'the component'}.` : 'Saved to embed.'); // i18n-ignore: write-only status, never rendered.
        return true;
      } finally {
        setBusyBoth(false);
      }
    },
    [documentByKey, passesClassGate, refreshDerived, setBusyBoth, settleEmbedWrite, setStatus],
  );
  // The declaration the canvas can preview for an edit of `rule`, or undefined when it can't.
  const liveTargetOf = useCallback(
    (rule: ParsedRule, prop: string): LiveRuleTarget | undefined => {
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        return undefined;
      }
      return liveRuleTargetOf(rule, embedDocument.source, prop, getHost().projectPath);
    },
    [documentByKey],
  );
  return { applyEdit, classGatesRef, liveTargetOf };
}

// Set and clear a property on an embed rule.
export function usePropEdits(splitForEditHook: ReturnType<typeof useSplitForEdit>, applyEditHook: ReturnType<typeof useApplyEdit>) {
  const { isGroupedSplittable, splitForEdit } = splitForEditHook;
  const { applyEdit, liveTargetOf } = applyEditHook;

  // The canvas shows an edit before its save lands (model/liveRuleEdits.ts). A grouped
  // rule's member is split out of its group by the save, so its edit is not previewed:
  // on the canvas the group's other selectors would change with it.
  const previewEdit = useCallback(
    (rule: ParsedRule, prop: string, edit: LiveRuleEdit): LiveRulePreview | undefined => {
      if (isGroupedSplittable(rule)) {
        return undefined;
      }
      const target = liveTargetOf(rule, prop);
      return target === undefined ? undefined : liveRules.show(target, edit);
    },
    [isGroupedSplittable, liveTargetOf],
  );

  // Property-addressed writes for always-rendered controls. We look up nodes in
  // the live postcss AST (not rule.declarations) so these stay correct after a
  // live edit appended a node the model hasn't rebuilt yet — otherwise a blur
  // commit would double-add. Update-or-add on set; remove every match on clear.
  const onSetProp = useCallback(
    (rule: ParsedRule, prop: string, value: string, important: boolean) => {
      const edit: LiveRuleEdit = { kind: 'value', value, important };
      const preview = previewEdit(rule, prop, edit);
      const saving = applyEdit(rule, () => {
        const { rule: editRule } = splitForEdit(rule);
        if (isPaddingProperty(prop)) {
          setPaddingDeclaration(editRule.node, prop, { value, important });
          return;
        }
        const target = lastDeclFor(editRule, prop);
        if (target) {
          target.value = value;
          target.important = important;
          return;
        }
        return addDeclaration(editRule, prop, { value, important });
      });
      settlePreviews(saving, preview === undefined ? [] : [{ preview, edit }]);
    },
    [applyEdit, previewEdit, splitForEdit],
  );
  const onClearProp = useCallback(
    (rule: ParsedRule, prop: string | string[]) => {
      const props = Array.isArray(prop) ? prop : [prop];
      // A padding side grouped into a shorthand is rewritten, not removed, so only a
      // property's own declaration is previewed.
      const removed: LiveRuleEdit = { kind: 'removed' };
      const previews = props.filter((name) => !isPaddingProperty(name)).map((name) => previewEdit(rule, name, removed));
      const saving = applyEdit(rule, () => {
        const { rule: editRule } = splitForEdit(rule);
        // A side grouped into `padding` or an axis has no declaration of its own.
        const clearedPadding = clearPaddingSides(editRule.node, props);
        const targets: Declaration[] = [];
        directDecls(editRule.node).forEach((decl) => {
          if (props.includes(decl.prop)) {
            targets.push(decl);
          }
        });
        if (!targets.length && !clearedPadding) {
          return false;
        }
        targets.forEach((decl) => decl.remove());
        removeRuleIfEmpty(editRule);
        return;
      });
      settlePreviews(
        saving,
        previews.filter((preview) => preview !== undefined).map((preview) => ({ preview, edit: removed })),
      );
    },
    [applyEdit, previewEdit, splitForEdit],
  );
  return { onClearProp, onSetProp };
}

// Live writes to an embed rule while typing or scrubbing.
export function useLiveEdits(
  editorRefs: ReturnType<typeof useEditorRefs>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  splitForEditHook: ReturnType<typeof useSplitForEdit>,
) {
  const { inComponentRef } = editorRefs;
  const { documentByKey, markPending } = pendingWrites;
  const { isGroupedSplittable } = splitForEditHook;

  // What a live write overwrote, per property — captured on the FIRST live write since
  // the last commit, so onRevertProp can put it back if the edit is abandoned (scrubbing
  // out of a dropdown without picking). `undefined` records "the property wasn't there".
  const liveOriginRef = useRef(new Map<string, { value: string; important: boolean } | undefined>());
  // Live set while typing: mutate (or append) the AST node and write straight to
  // the embed so the canvas updates in real time — no busy flag, no model rebuild
  // (blur runs the authoritative onSetProp). Mirrors onLiveCommitValue.
  const onLiveSetProps = useCallback(
    (
      writes: readonly {
        readonly rule: ParsedRule;
        readonly prop: string;
        readonly value: string;
        readonly important: boolean;
      }[],
    ) => {
      const documents = new Map<EmbedDocument, { preview: LiveRulePreview; edit: LiveRuleEdit }[]>();
      for (const { rule, prop, value, important } of writes) {
        // Defer grouped-splittable edits to the blur commit (onSetProp splits first).
        if (isGroupedSplittable(rule)) {
          continue;
        }
        const embedDocument = documentByKey.get(rule.embedKey);
        if (!embedDocument) {
          continue;
        }
        const edit: LiveRuleEdit = { kind: 'value', value, important };
        const target = liveRuleTargetOf(rule, embedDocument.source, prop, getHost().projectPath);
        const previews = documents.get(embedDocument) ?? [];
        if (target !== undefined) {
          previews.push({ preview: liveRules.show(target, edit), edit });
        }
        const matches = declsFor(rule, prop);
        const last = matches[matches.length - 1];
        if (!liveOriginRef.current.has(prop)) {
          liveOriginRef.current.set(prop, last ? { value: last.value, important: !!last.important } : undefined);
        }
        if (last) {
          last.value = value;
          last.important = important;
        } else {
          appendDecl(rule.node, prop, { value, important });
        }
        documents.set(embedDocument, previews);
      }
      for (const [embedDocument, previews] of documents) {
        const saving = writeEmbedDocument(embedDocument, true).then((result) => {
          if (!result.ok && inComponentRef.current && !embedDocument.source.fromComponent) {
            markPending(embedDocument.source.key);
          }
          return result.ok;
        });
        settlePreviews(saving, previews);
      }
    },
    [documentByKey, markPending, isGroupedSplittable, inComponentRef],
  );
  return { liveOriginRef, onLiveSetProps };
}

// Revert live writes, remove a rule, and save a rule's CSS.
export function useRuleActions(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  splitForEditHook: ReturnType<typeof useSplitForEdit>,
  applyEditHook: ReturnType<typeof useApplyEdit>,
  liveEdits: ReturnType<typeof useLiveEdits>,
) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { inComponentRef } = editorRefs;
  const { setSaveError } = busyState;
  const { documentByKey, markPending } = pendingWrites;
  const { splitForEdit } = splitForEditHook;
  const { applyEdit } = applyEditHook;
  const { liveOriginRef } = liveEdits;

  // Undo the live writes for `prop` — restore the value they overwrote, or remove the
  // declaration again if there wasn't one. The rule itself is left alone even if that
  // empties it: an abandoned preview must not delete anything the user had.
  const onRevertProp = useCallback(
    (rule: ParsedRule, prop: string) => {
      if (!liveOriginRef.current.has(prop)) {
        return;
      }
      const origin = liveOriginRef.current.get(prop);
      liveOriginRef.current.delete(prop);
      const embedDocument = documentByKey.get(rule.embedKey);
      if (!embedDocument) {
        return;
      }
      // The canvas shows the reverted value at once, as it showed the live writes.
      const edit: LiveRuleEdit = origin ? { kind: 'value', value: origin.value, important: origin.important } : { kind: 'removed' };
      const liveTarget = liveRuleTargetOf(rule, embedDocument.source, prop, getHost().projectPath);
      const preview = liveTarget === undefined ? undefined : liveRules.show(liveTarget, edit);
      const matches = declsFor(rule, prop);
      const last = matches[matches.length - 1];
      if (origin) {
        if (last) {
          last.value = origin.value;
          last.important = origin.important;
        } else {
          appendDecl(rule.node, prop, { value: origin.value, important: origin.important });
        }
      } else if (last) {
        last.remove();
      }
      const saving = writeEmbedDocument(embedDocument, true).then((result) => {
        if (!result.ok && inComponentRef.current && !embedDocument.source.fromComponent) {
          markPending(embedDocument.source.key);
        }
        return result.ok;
      });
      settlePreviews(saving, preview === undefined ? [] : [{ preview, edit }]);
    },
    [documentByKey, markPending, inComponentRef, liveOriginRef],
  );
  const onRemoveRule = useCallback(
    (rule: ParsedRule) => {
      void applyEdit(rule, () => removeRule(splitForEdit(rule).rule));
    },
    [applyEdit, splitForEdit],
  );
  const onSaveCssRule = useCallback(
    (rule: ParsedRule, css: string) => {
      void applyEdit(rule, () => {
        const result = replaceRuleCss(rule, css);
        if (!result.ok) {
          setSaveError(translate('styleModel.embed.hook.invalidCss', { reason: translateDescribed({ message: result.error, messageRef: result.errorRef }) }));
          return false;
        }
        return true;
      });
    },
    [applyEdit, setSaveError, translate, translateDescribed],
  );
  return { onRemoveRule, onRevertProp, onSaveCssRule };
}

// Open an embed on the canvas, and keep the resolved view for the next mount.
export function useOpenEmbed(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { pageInstancesRef, selectedElementKeyRef } = editorRefs;
  const { quickSnapshot, scan, setStatus } = scanState;
  const { documentByKey } = pendingWrites;

  // Select the source embed on the Webflow canvas (from a provenance embed chip).
  // Component embeds carry no page instance, so pass the current page's instances
  // for navigateToEmbed to find one to enter.
  const openEmbedByKey = useCallback(
    (embedKey: string) => {
      const embedDocument = documentByKey.get(embedKey);
      if (!embedDocument) {
        setStatus('Lost track of the source embed — try Rescan.'); // i18n-ignore: write-only status, never rendered.
        return;
      }
      void navigateToEmbed(embedDocument.source, pageInstancesRef.current).then((result) => {
        if (!result.ok) {
          setStatus(`Couldn't open it on the canvas: ${result.error}`); // i18n-ignore: write-only status, never rendered.
        }
      });
    },
    [documentByKey, pageInstancesRef, setStatus],
  );

  // Keep the resolved view at module scope so the next mount starts from it (see
  // editorSession.view). Written as it changes rather than on unmount, which React skips
  // when the whole tree goes.
  useEffect(() => {
    const host = getHost();
    if (!host.selectedId || !scan) {
      return;
    }
    editorSession.view = {
      hostId: host.selectedId,
      filePath: host.openFilePath,
      elementKey: selectedElementKeyRef.current,
      scan,
      quick: quickSnapshot,
    };
  }, [scan, quickSnapshot, selectedElementKeyRef]);
  return { openEmbedByKey };
}

// The element's snapshot, tokens, and selector suggestions.
export function useElementTokens(scanState: ReturnType<typeof useScanState>) {
  const { quickSnapshot, removedClasses, scan } = scanState;

  // Prefer the scan's full rootSnapshot; fall back to the fast quick snapshot so
  // the chips show while the scan is still running. Either can still carry a class
  // the element has just lost (both union in what the preview last reported), so
  // those are taken out here rather than waited out.
  const snapshot = useMemo(() => withoutClasses(scan?.rootSnapshot ?? quickSnapshot ?? undefined, removedClasses), [scan, quickSnapshot, removedClasses]);

  const model = scan?.model;
  const tokens = useMemo(() => snapshotTokens(snapshot), [snapshot]);

  // Autocomplete suggestions for the add-selector input: the element's tag, each
  // class, each data attribute (presence, then valued), then its combo class chains
  // (cumulative in applied order, like Webflow combos).
  const selectorSuggestions = useMemo<SelectorSuggestion[]>(() => {
    const out: SelectorSuggestion[] = [];
    const tagTok = tokens.find((token) => token.kind === 'tag');
    if (tagTok) {
      out.push({ selector: tagTok.label ?? tagTok.name, kind: 'tag' });
    }
    const classNames = tokens.filter((token) => token.kind === 'class').map((token) => token.label ?? token.name.slice('class:'.length));
    for (const cls of classNames) {
      out.push({ selector: `.${cls}`, kind: 'class' });
    }
    const attrNames = tokens.filter((token) => token.kind === 'attribute').map((token) => token.label ?? token.name.slice('attr:'.length));
    for (const name of attrNames) {
      out.push({ selector: `[${name}]`, kind: 'attribute' });
    }
    for (const name of attrNames) {
      const value = snapshot?.attributes?.[name];
      if (value) {
        out.push({ selector: `[${name}="${value}"]`, kind: 'attribute-value' });
      }
    }
    for (let i = 2; i <= classNames.length; i += 1) {
      out.push({
        selector: classNames
          .slice(0, i)
          .map((name) => `.${name}`)
          .join(''),
        kind: 'combo',
      });
    }
    return out;
  }, [tokens, snapshot]);
  // The classes this instance passed to the open component (model/instanceClasses.ts).
  // The snapshot is rebuilt on every selection and every class the canvas reports,
  // and opening or leaving a component rescans, so it is the memo's whole input.
  const instanceClasses = useMemo(() => selectedInstanceClasses(snapshot?.classList ?? []), [snapshot]);
  // What the element's node writes in the open component, which makes a chip green
  // (model/componentMarkup.ts). Read on the same rebuilds as the instance classes:
  // a class written into the markup changes the snapshot too.
  const componentMarkup = useMemo(() => (snapshot === undefined ? undefined : selectedComponentMarkup()), [snapshot]);
  return { componentMarkup, instanceClasses, model, scan, selectorSuggestions, snapshot, tokens };
}

// Report a save's outcome to the canvas previews it carried: kept until the page holds
// the edit when it landed, put back now when it did not. A save that throws is reported
// as not landed and still rejects, so the error stays as loud as before.
function settlePreviews(saving: Promise<boolean>, previews: readonly { readonly preview: LiveRulePreview; readonly edit: LiveRuleEdit }[]): void {
  if (previews.length === 0) {
    void saving;
    return;
  }
  let landed = false;
  void saving
    .then((outcome) => {
      landed = outcome;
    })
    .finally(() => {
      for (const { preview, edit } of previews) {
        if (landed) {
          liveRules.landed(preview, edit);
        } else {
          liveRules.failed(preview);
        }
      }
    });
}
