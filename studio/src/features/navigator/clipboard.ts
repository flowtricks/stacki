import type { SharedDocument } from '../collaboration/useDocument';
import { getEditorRole } from '../roles/roleStore';
import { frontmatterRange } from '../source/frontmatter';
import type { NodeClipboard } from '../source/clipboardPayload';
import { bounds, nodeAt } from '../source/source';
import type { Component } from '../project/projectClient';
import { pastePlacement } from './pastePlacement';

let copied: NodeClipboard | undefined;
export function hasCopiedNode() {
  return copied !== undefined;
}
export function copyNode(document: SharedDocument | undefined, id: string, report: (error: unknown) => void) {
  if (!document) {
    return;
  }
  if (getEditorRole() === 'client' && id === 'layout') {
    return;
  }
  try {
    const source = document.text.toString();
    const range = bounds(nodeAt(source, id));
    copied = {
      file: document.file,
      fragment: source.slice(range.start, range.end),
      frontmatter: frontmatterRange(source)?.value ?? '',
    };
  } catch (error) {
    report(error);
  }
}
export function pasteNode(document: SharedDocument | undefined, target: string, report: (error: unknown) => void, components: readonly Component[]) {
  if (!document || !copied) {
    return;
  }
  try {
    void document
      .action({
        kind: 'paste',
        target,
        placement: pastePlacement(document.text.toString(), document.file, target, components),
        clipboard: copied,
      })
      .catch(report);
  } catch (error) {
    report(error);
  }
}
