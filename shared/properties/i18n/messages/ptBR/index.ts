// Brazilian Portuguese: every namespace merged into the one catalog the lazy loader imports (docs/i18n.md).
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/index';
import { messages as ai } from './ai';
import { messages as apps } from './apps';
import { messages as assets } from './assets';
import { messages as audits } from './audits';
import { messages as auditsUi } from './auditsUi';
import { messages as cms } from './cms';
import { messages as cmsBackend } from './cmsBackend';
import { messages as cmsConnections } from './cmsConnections';
import { messages as cmsRemote } from './cmsRemote';
import { messages as componentProps } from './componentProps';
import { messages as contentUi } from './contentUi';
import { messages as dialog } from './dialog';
import { messages as editor } from './editor';
import { messages as error } from './error';
import { messages as git } from './git';
import { messages as history } from './history';
import { messages as instructionsPanel } from './instructionsPanel';
import { messages as menu } from './menu';
import { messages as pages } from './pages';
import { messages as palette } from './palette';
import { messages as preview } from './preview';
import { messages as props } from './props';
import { messages as publish } from './publish';
import { messages as rail } from './rail';
import { messages as roles } from './roles';
import { messages as selectors } from './selectors';
import { messages as settings } from './settings';
import { messages as shell } from './shell';
import { messages as structure } from './structure';
import { messages as studio } from './studio';
import { messages as studioSetup } from './studioSetup';
import { messages as style } from './style';
import { messages as styleModel } from './styleModel';
import { messages as ui } from './ui';
import { messages as variables } from './variables';
import { messages as welcome } from './welcome';
import { messages as workspace } from './workspace';

export const messages = {
  ...ai,
  ...apps,
  ...assets,
  ...audits,
  ...auditsUi,
  ...cms,
  ...cmsBackend,
  ...cmsConnections,
  ...cmsRemote,
  ...componentProps,
  ...contentUi,
  ...dialog,
  ...editor,
  ...error,
  ...git,
  ...history,
  ...instructionsPanel,
  ...menu,
  ...pages,
  ...palette,
  ...preview,
  ...props,
  ...publish,
  ...rail,
  ...roles,
  ...selectors,
  ...settings,
  ...shell,
  ...structure,
  ...studio,
  ...studioSetup,
  ...style,
  ...styleModel,
  ...ui,
  ...variables,
  ...welcome,
  ...workspace,
} as const satisfies CatalogOf<MessageKey>;
