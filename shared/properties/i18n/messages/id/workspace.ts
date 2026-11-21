// Indonesian `workspace` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/workspace';

export const messages = {
  'workspace.code.close': 'Tutup (suntingan disimpan langsung)',
  'workspace.code.title': 'Kode',
  'workspace.notifications.dismiss': 'Tutup notifikasi',
  'workspace.notifications.label': 'Notifikasi',
  'workspace.notifications.loadMore': 'Muat lebih banyak ({count})',
  'workspace.notifications.showFewer': 'Tampilkan lebih sedikit',
  'workspace.terminal.close': 'Tutup terminal',
  'workspace.terminal.custom': 'Kustom…',
  'workspace.terminal.customPlaceholder': 'mis. bun run watch',
  'workspace.terminal.customTitle': 'Jalankan sekali di setiap terminal baru',
  'workspace.terminal.hide': 'Sembunyikan terminal ({shortcut})',
  'workspace.terminal.loading': 'Memuat terminal',
  'workspace.terminal.new': 'Terminal baru',
  'workspace.terminal.resize': 'Seret untuk mengubah ukuran',
  'workspace.terminal.scrollBottom': 'Gulir ke bawah',
  'workspace.terminal.shellOnly': 'Hanya shell',
} as const satisfies CatalogOf<MessageKey>;
