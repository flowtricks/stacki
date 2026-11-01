// Check tracked editor metadata before CI or an external component refactor is considered done.
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { readMetadataSource } from '../src/features/settings/projectMetadata';
import { defaultsIssues } from '../vendor/stacki/shared/properties/componentDefaults';
import { validateMetadata } from '../vendor/stacki/shared/properties/projectMetadata';
import { EMPTY_KEEP_LIST, parseStyleKeepList } from '../vendor/stacki/shared/properties/styleKeepList';
import { checkSelectorUsage } from '../vendor/stacki/electron/properties/selectorUsageFiles';

export async function checkProject(root: string): Promise<void> {
  const sources = await readMetadataSource(root, 'componentSources');
  if (sources.source !== undefined) {
    validateMetadata('componentSources', sources.source);
  }
  const settings = await loadInsertionDefaults(root);
  const issues = defaultsIssues(settings.config, settings.catalog);
  const guide = await readMetadataSource(root, 'guide');
  if (guide.source !== undefined) {
    validateMetadata('guide', guide.source);
  }
  const publishing = await readMetadataSource(root, 'publish');
  if (publishing.source !== undefined) {
    validateMetadata('publish', publishing.source);
  }
  const pages = await readMetadataSource(root, 'pages');
  if (pages.source !== undefined) {
    validateMetadata('pages', pages.source);
  }
  const styles = await readMetadataSource(root, 'styles');
  if (styles.source !== undefined) {
    validateMetadata('styles', styles.source);
  }
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
  console.log('Project component defaults, guide, page order, publish and styles settings are valid.');
  await reportUnusedSelectors(root, styles.source);
}

// Unused selectors are reported, not failed: a leftover rule costs bytes, and
// the decision to delete it belongs to whoever reads the report. Only proven
// unused selectors are listed; the panel's "Can't tell" ones are counted.
async function reportUnusedSelectors(root: string, keepSource: string | undefined): Promise<void> {
  const parsed: unknown = keepSource === undefined ? undefined : JSON.parse(keepSource);
  const keepList = parsed === undefined ? EMPTY_KEEP_LIST : parseStyleKeepList(parsed);
  const { report } = await checkSelectorUsage(root, keepList);
  const unused = report.entries.filter((entry) => entry.verdict.kind === 'unused');
  const unknown = report.entries.filter((entry) => entry.verdict.kind === 'unknown').length;
  for (const entry of unused) {
    const names = entry.verdict.kind === 'unused' ? entry.verdict.names.join(', ') : '';
    console.log(`  unused  ${entry.rel}:${entry.line}  ${entry.selector}  (nothing produces ${names})`);
  }
  for (const note of report.notes) {
    console.log(`  not checked  ${note.rel}: ${note.message}`);
  }
  const unknownText = unknown === 0 ? '' : `; ${unknown} could not be proven either way`;
  console.log(`Style selectors: ${unused.length} unused of ${report.entries.length}${unknownText}. Lock names to keep in .stacki/styles.json.`);
}
