// Check tracked editor metadata before CI or an external component refactor is considered done.
import { checkAuthProvider } from './checkAuth';
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { readMetadataSource } from '../src/features/settings/projectMetadata';
import { defaultsIssues } from '../vendor/stacki/shared/properties/componentDefaults';
import { defaultAssetUses } from '../vendor/stacki/shared/properties/componentDefaultValues';
import { validateMetadata } from '../vendor/stacki/shared/properties/projectMetadata';
import { canvasIssues, parseComponentCanvasSource } from '../vendor/stacki/shared/properties/componentCanvas';
import { EMPTY_KEEP_LIST, parseStyleKeepList } from '../vendor/stacki/shared/properties/styleKeepList';
import { checkSelectorUsage } from '../vendor/stacki/electron/properties/selectorUsageFiles';
import { configOf, foldersFor, readProjectFoldersSource } from '../vendor/stacki/shared/properties/projectFolders';

export async function checkProject(root: string): Promise<void> {
  const sources = await readMetadataSource(root, 'componentSources');
  if (sources.source !== undefined) {
    validateMetadata('componentSources', sources.source);
  }
  const settings = await loadInsertionDefaults(root);
  const gone = new Set(settings.missingAssets);
  const issues = [
    ...defaultsIssues(settings.config, settings.catalog),
    ...defaultAssetUses(settings.config)
      .filter((use) => gone.has(use.file))
      .map((use) => `.stacki/components.json: ${use.owner} default ${use.prop} imports ${use.file}, which is not in the project.`),
  ];
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
  const folders = await readMetadataSource(root, 'folders');
  if (folders.source !== undefined) {
    validateMetadata('folders', folders.source);
  }
  const canvas = await readMetadataSource(root, 'componentCanvas');
  const canvasProblems: string[] = [];
  if (canvas.source !== undefined) {
    const parsed = parseComponentCanvasSource(canvas.source);
    if (!parsed.ok) {
      throw new Error(`.stacki/component-canvas.json: ${parsed.error.message}`);
    }
    canvasProblems.push(
      ...canvasIssues(
        parsed.value,
        settings.catalog.map((component) => component.file),
      ),
    );
  }
  if (issues.length + canvasProblems.length > 0) {
    throw new Error([...issues, ...canvasProblems].join('\n'));
  }
  console.log('Project component defaults, component canvas, guide, page order, publish, styles and folder settings are valid.');
  await checkAuthProvider(root);
  await reportUnusedSelectors(root, styles.source, foldersFor('styles', configOf(readProjectFoldersSource(folders.source))));
}

// Unused selectors are reported, not failed: a leftover rule costs bytes, and
// the decision to delete it belongs to whoever reads the report. Only proven
// unused selectors are listed; the panel's "Can't tell" ones are counted.
async function reportUnusedSelectors(root: string, keepSource: string | undefined, styleFolders: readonly string[]): Promise<void> {
  const parsed: unknown = keepSource === undefined ? undefined : JSON.parse(keepSource);
  const keepList = parsed === undefined ? EMPTY_KEEP_LIST : parseStyleKeepList(parsed);
  const { report } = await checkSelectorUsage(root, keepList, 'search', styleFolders);
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
