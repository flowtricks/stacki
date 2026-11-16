// The context-aware paste, as the app runs it (plan: src/editor/pasteDependencies.ts; pieces:
// src/app/model/contextPaste.ts). A paste into another file brings what the markup needs, or
// asks how to paste it when something cannot travel, and writes it all as one undo step with
// a summary toast: "Pasted. Also brought along: …" with Undo and What changed.
//
// A paste inside the file it was copied from is the ordinary paste, untouched.

import { useCallback } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { EditorNode } from '../../editor/pageView';
import type { InsertPlace } from '../../editor/editGestures';
import { planPaste, type PasteBundle, type PastePlan } from '../../editor/pasteDependencies';
import { getNewStyleTagSettings } from '../../features/style/model/newStyleTagSettings';
import { styleBlockFileSupported } from '../../features/style/model/firstStyleBlock';
import { readNewStyleTag } from '../../ipc/newStyleTagBridge';
import { rebaseProjectImport } from '../../ipc/appBridge';
import { choiceDialog, confirmDialog } from '../../ui/ConfirmDialog';
import { reportActionToast } from '../../ui/errorNotices';
import type { NodeClipboard } from '../appTypes';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { Translator } from '../../lib/i18n/localeContext';
import type { EditorModel } from '../../editor/pageView';
import type { ImportPaths } from '../../ipc/appBridge';
import {
  blockerLines,
  bundleImportsFor,
  carriedStyleNode,
  contextPasteGesture,
  instanceNode,
  pasteChangeLines,
  pasteSummary,
  pasteTargetOf,
  withBundleFrontmatter,
} from '../model/contextPaste';
import { chooseImportPath } from '../model/pageModelGestures';
import type { useCoreState } from './appLifecycle';
import type { useLifecycle } from './appNavigation';
import type { useAddComponent, useHistory } from './appNodeEdits';

/** `same-file`: the caller pastes as it always did. `handled`: written, refused or cancelled here. */
export type ContextPasteOutcome = 'same-file' | 'handled';

export function useContextPaste(
  coreState: ReturnType<typeof useCoreState>,
  addComponentScope: Pick<ReturnType<typeof useAddComponent>, 'resolveImportPath'>,
  _lifecycle: ReturnType<typeof useLifecycle>,
  history: Pick<ReturnType<typeof useHistory>, 'commitEdit' | 'undo'>,
) {
  const translate = useTranslate();
  const { insertables, pageStateRef, projectRef, setSelectedId } = coreState;
  const { resolveImportPath } = addComponentScope;
  const { commitEdit, undo } = history;

  const contextPaste = useCallback(
    async (clip: NodeClipboard, pasted: EditorNode, place: InsertPlace): Promise<ContextPasteOutcome> => {
      const source = clip.source;
      const state = pageStateRef.current.pageState;
      const page = pageStateRef.current.currentPage;
      if (source === undefined || state === undefined || !state.editable || page?.path === undefined) {
        return 'same-file';
      }
      const targetPath = page.path;
      const role = page.kind === 'component' ? 'component' : 'page';
      const plan: PastePlan = planPaste(pasted, source, pasteTargetOf(state.model, { path: page.path, role }));
      if (plan.kind === 'same-file') {
        return 'same-file';
      }
      const bundle =
        plan.kind === 'ready' ? plan.bundle : await chosenBundle(plan, { targetPath, model: state.model, insertables, resolveImportPath, translate });
      if (bundle === undefined) {
        return 'handled';
      }
      const imports = await bundleImportsFor(bundle, {
        insertables,
        sourcePath: source.path,
        targetModel: state.model,
        resolveImportPath,
        rebase: async (fromPath, spec) => (await rebaseProjectImport(fromPath, targetPath, spec)).path,
      });
      const settings = await styleSettings(projectRef.current?.path);
      // Written against the page as shown now: the lookups above awaited, and edits made meanwhile are part of it.
      const now = pageStateRef.current.pageState;
      if (now === undefined || !now.editable || pageStateRef.current.currentPage?.path !== targetPath) {
        return 'handled';
      }
      const style = styleBlockFileSupported(targetPath) ? carriedStyleNode(bundle, settings, now.source) : undefined;
      const gesture = contextPasteGesture(now.model, { node: bundle.node, place, style }, withBundleFrontmatter(imports, bundle.statements));
      if (!commitEdit(gesture)) {
        return 'handled';
      }
      setSelectedId(bundle.node.id);
      announce(bundle, translate, undo);
      return 'handled';
    },
    [commitEdit, insertables, pageStateRef, projectRef, resolveImportPath, setSelectedId, translate, undo],
  );

  return { contextPaste };
}

interface ChoiceContext {
  readonly targetPath: string;
  readonly model: EditorModel;
  readonly insertables: readonly ScanComponent[];
  readonly resolveImportPath: (componentPath: string) => Promise<ImportPaths>;
  readonly translate: Translator;
}

// The choice, in a designer's words, and the bundle it stands for; undefined when cancelled.
async function chosenBundle(plan: Extract<PastePlan, { readonly kind: 'choose' }>, context: ChoiceContext): Promise<PasteBundle | undefined> {
  const { translate } = context;
  const instance = plan.instance;
  const reasons = blockerLines(plan.blockers, translate).join('\n');
  const choices = [
    ...(instance === undefined
      ? []
      : [
          {
            id: 'instance',
            label: translate('editor.paste.choice.instance', { name: instance.name }),
            hint: translate('editor.paste.choice.instanceHint', { name: instance.name }),
            recommended: instance.recommended,
          },
        ]),
    {
      id: 'filled',
      label: translate('editor.paste.choice.filled'),
      hint: translate('editor.paste.choice.filledHint'),
      recommended: instance === undefined || !instance.recommended,
    },
  ];
  const title = instance === undefined ? translate('editor.paste.choice.titleFile') : translate('editor.paste.choice.title', { name: instance.name });
  const answer = await choiceDialog({ title, body: `${translate('editor.paste.choice.body')}\n${reasons}`, choices });
  if (answer === 'filled') {
    return plan.filled;
  }
  if (answer === 'instance') {
    return instance === undefined ? undefined : instanceBundle(instance.name, context);
  }
  return undefined;
}

// Option (a): the component itself, imported from where it lives. Never into the component's own file.
async function instanceBundle(name: string, context: ChoiceContext): Promise<PasteBundle | undefined> {
  const component = context.insertables.find((candidate) => candidate.name === name);
  if (component === undefined || component.path === context.targetPath) {
    return undefined;
  }
  const path = chooseImportPath(context.model, await context.resolveImportPath(component.path));
  const has = context.model.imports.some((entry) => entry.name === name);
  return {
    node: instanceNode(name),
    imports: has ? [] : [{ name, path, quote: "'" }],
    statements: [],
    styles: { rules: [], selectors: [], leftBehind: [], defineVars: undefined },
    changes: has ? [] : [{ kind: 'import', name, path }],
  };
}

// The summary toast, with Undo and What changed.
function announce(bundle: PasteBundle, translate: Translator, undo: () => Promise<void>): void {
  const summary = pasteSummary(bundle.changes, translate);
  if (summary === undefined) {
    return;
  }
  const lines = pasteChangeLines(bundle.changes, translate);
  reportActionToast(summary, 'info', [
    { label: translate('editor.paste.undo'), run: () => undo() },
    {
      label: translate('editor.paste.whatChanged'),
      run: async () => {
        await confirmDialog({
          title: translate('editor.paste.whatChangedTitle'),
          body: lines.map((line) => `• ${line}`).join('\n'),
          cancelLabel: translate('ui.close'),
        });
      },
    },
  ]);
}

// The project's setting for new style tags, read fresh; the last value the Style panel read when the file cannot be.
async function styleSettings(projectPath: string | undefined): Promise<ReturnType<typeof getNewStyleTagSettings>> {
  if (projectPath === undefined) {
    return getNewStyleTagSettings();
  }
  try {
    return await readNewStyleTag(projectPath);
  } catch {
    return getNewStyleTagSettings();
  }
}
