// Turkish `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Kapat (düzenlemeler anında kaydedilir)',
  'workspace.code.title': 'Kod',
  'workspace.notifications.copied': 'Kopyalandı',
  'workspace.notifications.copy': 'Kopyala',
  'workspace.notifications.dismiss': 'Bildirimi kapat',
  'workspace.notifications.label': 'Bildirimler',
  'workspace.notifications.loadMore': 'Daha fazla yükle ({count})',
  'workspace.notifications.showFewer': 'Daha az göster',
  'workspace.terminal.close': 'Terminali kapat',
  'workspace.terminal.custom': 'Özel…',
  'workspace.terminal.customPlaceholder': 'ör. bun run watch',
  'workspace.terminal.customTitle': 'Her yeni terminalde bir kez çalıştır',
  'workspace.terminal.hide': 'Terminali gizle ({shortcut})',
  'workspace.terminal.loading': 'Terminal yükleniyor',
  'workspace.terminal.new': 'Yeni terminal',
  'workspace.terminal.resize': 'Yeniden boyutlandırmak için sürükleyin',
  'workspace.terminal.scrollBottom': 'En alta kaydır',
  'workspace.terminal.shellOnly': 'Yalnızca kabuk',
} as const satisfies CatalogOf<MessageKey>;
