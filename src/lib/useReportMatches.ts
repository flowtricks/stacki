// A foldable Settings section tells the panel how many rows match the search, so the panel can say when no section
// does (SettingsSectionsContext.report). Told before the browser paints, so "no instructions match" never flashes
// for a frame between a section mounting and its count arriving.
import { useLayoutEffect } from 'react';
import type { SettingsSectionId, SettingsSectionsContext } from './settingsSections';

export function useReportMatches(context: Pick<SettingsSectionsContext, 'report'>, id: SettingsSectionId, matches: number | undefined): void {
  const { report } = context;
  useLayoutEffect(() => report(id, matches), [report, id, matches]);
}
