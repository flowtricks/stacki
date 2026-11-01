import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { layoutPageTitle } from '../../../shared/page/pageTitle';
import type { ScanResult } from '../../../shared/properties/projectScan';
import type { CurrentPage, EditorPageState } from '../../editor/pageState';

interface PageTitleState {
  readonly currentPage: CurrentPage | undefined;
  readonly pageState: EditorPageState | undefined;
  readonly setScan: Dispatch<SetStateAction<ScanResult>>;
}

export function usePageTitles({ currentPage, pageState, setScan }: PageTitleState): void {
  const titlePath = currentPage?.kind === 'page' ? currentPage.path : undefined;
  const nodes = pageState?.editable ? pageState.model.nodes : undefined;
  useEffect(() => {
    if (titlePath === undefined || !pageState?.editable) {
      return;
    }
    // Self-writes bypass filesystem notifications; remember live labels across page switches.
    setScan((scan) => {
      const page = scan.pages.find((entry) => entry.path === titlePath);
      const title = nodes ? layoutPageTitle(nodes, page?.inheritedTitle) : undefined;
      return updatePageTitle(scan, titlePath, title);
    });
  }, [titlePath, nodes, pageState?.editable, setScan]);
}

export function updatePageTitle(scan: ScanResult, path: string, title: string | undefined): ScanResult {
  const page = scan.pages.find((entry) => entry.path === path);
  if (page === undefined || page.title === title) {
    return scan;
  }
  return {
    ...scan,
    pages: scan.pages.map((entry) => (entry.path === path ? { ...entry, title } : entry)),
  };
}
