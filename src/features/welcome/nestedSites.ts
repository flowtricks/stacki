// The question for a folder with websites inside it (shared/ipc/astroCopy.ts, NestedSitesChoice): where the one
// website is, or which of several to open. It is the app's own choice dialog, one filled button per answer, and
// nothing opens until the person picks one. What the picked folder could do by itself stays on offer, last.
import { choiceDialog, type DialogChoice } from '../../ui/ConfirmDialog';
import { assert } from '../../../shared/core/assert';
import type { Translator } from '../../lib/i18n/localeContext';
import type { AstroCopyOffer, NestedSite, NestedSitesChoice } from '../../../shared/ipc/astroCopy';

export type NestedSitesAnswer =
  /** Open this folder as the project: a site inside, or the picked folder itself when the person says so. */
  { readonly kind: 'open'; readonly projectPath: string } | { readonly kind: 'copy'; readonly offer: AstroCopyOffer } | { readonly kind: 'canceled' };

const INSTEAD = 'instead';

/** Asks which folder to open. Cancel, Escape and a click outside open nothing. */
export async function askNestedSites(choice: NestedSitesChoice, translate: Translator): Promise<NestedSitesAnswer> {
  const [first] = choice.sites;
  assert(first !== undefined, 'askNestedSites: a site to offer');
  const folder = folderName(choice.folderPath);
  const only = choice.sites.length === 1;
  const answers = choice.sites.map((site, index) => (only ? onlySiteAnswer(site, translate) : siteAnswer(site, index)));
  const other = insteadAnswer(choice, folder, translate);
  const id = await choiceDialog({
    title: translate(only ? 'welcome.nested.oneTitle' : 'welcome.nested.manyTitle'),
    body: only
      ? translate('welcome.nested.oneBody', { path: first.relative, folder })
      : translate('welcome.nested.manyBody', { count: choice.sites.length, folder }),
    choices: other === undefined ? answers : [...answers, other],
    className: 'nested-sites-dialog',
  });
  if (id === undefined) {
    return { kind: 'canceled' };
  }
  if (id === INSTEAD) {
    return insteadResult(choice);
  }
  const site = choice.sites.find((candidate) => candidate.projectPath === id);
  assert(site !== undefined, 'askNestedSites: the answer is one that was offered');
  return { kind: 'open', projectPath: site.projectPath };
}

// One website: the button opens it, and the line under it says what it is.
function onlySiteAnswer(site: NestedSite, translate: Translator): DialogChoice {
  return { id: site.projectPath, label: translate('welcome.nested.openOne'), hint: site.name ?? site.relative, recommended: true };
}

// Several: each is named by where it is, with its package name where that says more than the folder does.
function siteAnswer(site: NestedSite, index: number): DialogChoice {
  assert(index >= 0, 'siteAnswer: a position in the list');
  const name = site.name === undefined || site.name === folderName(site.relative) ? undefined : site.name;
  return { id: site.projectPath, label: site.relative, ...(name === undefined ? {} : { hint: name }) };
}

function insteadAnswer(choice: NestedSitesChoice, folder: string, translate: Translator): DialogChoice | undefined {
  switch (choice.instead.kind) {
    case 'openFolder':
      return { id: INSTEAD, label: translate('welcome.nested.openFolder', { folder }) };
    case 'plainWebsite':
      return { id: INSTEAD, label: translate('welcome.nested.copyFolder', { folder }) };
    case 'nothing':
      return undefined;
    default: {
      const exhaustive: never = choice.instead;
      return exhaustive;
    }
  }
}

function insteadResult(choice: NestedSitesChoice): NestedSitesAnswer {
  switch (choice.instead.kind) {
    case 'openFolder':
      return { kind: 'open', projectPath: choice.folderPath };
    case 'plainWebsite':
      return { kind: 'copy', offer: choice.instead.offer };
    case 'nothing':
      throw new Error('askNestedSites: the folder had nothing else to offer');
    default: {
      const exhaustive: never = choice.instead;
      return exhaustive;
    }
  }
}

// The last name of a path, on either separator; a drive's or the system's root keeps its whole spelling.
function folderName(folderPath: string): string {
  return (
    folderPath
      .split(/[\\/]/)
      .filter((segment) => segment !== '')
      .pop() ?? folderPath
  );
}
