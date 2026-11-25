// Turkish `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Yapay zekâ sohbeti',
  'rail.appWaiting': '{name}: {count} bekliyor',
  'rail.apps': 'Uygulamalar',
  'rail.assets': 'Varlıklar',
  'rail.audits': 'Denetimler',
  'rail.cms': 'CMS', // same
  'rail.code': 'Kod',
  'rail.collections': 'Koleksiyonlar',
  'rail.components': 'Bileşenler',
  'rail.editorPanels': 'Düzenleyici panelleri',
  'rail.elements': 'Öğe ekle',
  'rail.files': 'Dosyalar',
  'rail.history': 'Git', // same
  'rail.more': 'Daha fazla',
  'rail.moveDown': 'Aşağı taşı',
  'rail.moveToRail': 'Kenar çubuğuna taşı',
  'rail.moveUp': 'Yukarı taşı',
  'rail.movedBottom': '{label}: alt grup, {count} içinde {position}. sıra',
  'rail.movedSettings': '{label}: Ayarlar, {count} içinde {position}. sıra',
  'rail.movedTop': '{label}: üst grup, {count} içinde {position}. sıra',
  'rail.navigator': 'Gezgin',
  'rail.orderMenu': 'Çubuk sırası',
  'rail.pages': 'Sayfalar',
  'rail.properties': 'Özellikler',
  'rail.selectors': 'Stil seçicileri',
  'rail.settings': 'Ayarlar',
  'rail.settingsEmpty': "Ayarlar'da tutmak için kenar çubuğu simgelerini buraya sürükleyin",
  'rail.settingsOrder.description': 'Kenar çubuğundaki simgeleri sürükleyerek yeniden sıralayın. Varsayılan sıraya sıfırlayın.',
  'rail.settingsOrder.done': 'Kenar çubuğu sırası sıfırlandı',
  'rail.settingsOrder.label': 'Kenar çubuğu simge sırası',
  'rail.settingsOrder.reset': 'Varsayılana sıfırla',
  'rail.variables': 'Değişkenler',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
