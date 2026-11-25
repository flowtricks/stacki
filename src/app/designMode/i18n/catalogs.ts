// Every locale's Design mode catalog, by the app's locale tags (shared/core/i18n/locales.ts). All of them are
// bundled with the feature: the whole set is a few dozen kilobytes, and a mode entered from a menu must not wait
// for its words.
import type { Locale } from '../../../../shared/core/i18n/locales';
import { designModeEnglish, type DesignWordKey } from './en';
import { designModeAr } from './ar';
import { designModeDe } from './de';
import { designModeEs } from './es';
import { designModeFr } from './fr';
import { designModeHe } from './he';
import { designModeHi } from './hi';
import { designModeId } from './id';
import { designModeIt } from './it';
import { designModeJa } from './ja';
import { designModeKo } from './ko';
import { designModeNl } from './nl';
import { designModePl } from './pl';
import { designModePtBR } from './ptBR';
import { designModeRu } from './ru';
import { designModeTr } from './tr';
import { designModeZhCN } from './zhCN';
import { designModeZhTW } from './zhTW';

export type DesignCatalog = Readonly<Record<DesignWordKey, string>>;

export const designModeCatalogs: Readonly<Record<Locale, DesignCatalog>> = {
  en: designModeEnglish,
  es: designModeEs,
  fr: designModeFr,
  de: designModeDe,
  'pt-BR': designModePtBR,
  it: designModeIt,
  nl: designModeNl,
  pl: designModePl,
  tr: designModeTr,
  ru: designModeRu,
  id: designModeId,
  hi: designModeHi,
  ar: designModeAr,
  he: designModeHe,
  ja: designModeJa,
  ko: designModeKo,
  'zh-CN': designModeZhCN,
  'zh-TW': designModeZhTW,
};
