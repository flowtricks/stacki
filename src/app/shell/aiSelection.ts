// The two chips "Add to chat" makes of a selection in the open file (src/features/ai/addToChat.ts): the code
// as it was selected, and the file it is in, named for what that file is.
//
// Pure: the shell passes in the open file, the project's pages and parts, and the page on the canvas.
import { isElementName, isProjectRelativePath, type PageChip } from '../../../shared/properties/ai/mentions';
import type { ScanComponent, ScanPage } from '../../../shared/properties/projectScan';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { SelectionChips } from '../../features/ai/addToChat';
import type { SourceSelection } from '../../features/code/codePanelModel';
import { projectRelativePath } from '../../lib/projectPath';

/** What the chips' place needs to know: the open file, the project's pages and parts, and the page on the canvas. */
export interface PlaceSource {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  /** The open file's absolute path (the one the Code panel shows). */
  readonly openPath: string;
  /** The page the canvas shows, absolute, when the open file is something drilled into from it. */
  readonly canvasPagePath: string | undefined;
  readonly pages: readonly Pick<ScanPage, 'path' | 'name' | 'route' | 'title'>[];
  readonly layouts: readonly Pick<ScanComponent, 'path' | 'name'>[];
  readonly components: readonly Pick<ScanComponent, 'path' | 'name'>[];
  readonly pageName: (page: Pick<ScanPage, 'path' | 'name' | 'route' | 'title'>) => string;
}

/**
 * The two chips a selection of the open file becomes: its code, and the file it is in named for what that file is.
 * Undefined when the open file is outside the project.
 */
export function selectionChipsOf(place: PlaceSource, selection: SourceSelection): SelectionChips | undefined {
  const relative = (absolute: string): string => projectRelativePath(place.projectPath, absolute, place.platform);
  const path = relative(place.openPath);
  if (!isProjectRelativePath(path)) {
    return undefined;
  }
  const page = placeChipOf(place, path);
  const canvas = place.canvasPagePath === undefined ? undefined : relative(place.canvasPagePath);
  const viewedOn = canvas !== undefined && canvas !== path && isProjectRelativePath(canvas) ? canvas : undefined;
  const element = selection.element !== undefined && isElementName(selection.element) ? selection.element : undefined;
  return {
    code: { kind: 'code', path, startLine: selection.startLine, endLine: selection.endLine, element, code: selection.code },
    page: { ...page, viewedOn },
  };
}

function placeChipOf(place: PlaceSource, path: string): Omit<PageChip, 'viewedOn'> {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const stem = fileName.replace(/\.[^.]+$/u, '');
  const page = place.pages.find((entry) => entry.path === place.openPath);
  if (page !== undefined) {
    return { kind: 'page', role: 'page', path, name: place.pageName(page).slice(0, AI_LIMITS.titleCharsMax) || fileName, route: page.route };
  }
  const layout = place.layouts.find((entry) => entry.path === place.openPath);
  if (layout !== undefined) {
    return { kind: 'page', role: 'layout', path, name: layout.name || stem, route: undefined };
  }
  const component = place.components.find((entry) => entry.path === place.openPath);
  if (component !== undefined) {
    return { kind: 'page', role: 'component', path, name: component.name || stem, route: undefined };
  }
  // Anything under src/pages the scan has not listed yet is still a page; the rest is a file, and says so.
  const role = /(?:^|\/)src\/pages\//u.test(path) ? 'page' : 'file';
  return { kind: 'page', role, path, name: fileName, route: undefined };
}
