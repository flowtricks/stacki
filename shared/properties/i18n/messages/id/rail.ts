// Indonesian `rail` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/rail';

export const messages = {
  'rail.ai': 'Chat AI',
  'rail.appWaiting': '{name}: {count} menunggu',
  'rail.apps': 'Aplikasi',
  'rail.assets': 'Aset',
  'rail.audits': 'Audit',
  'rail.cms': 'CMS', // same
  'rail.code': 'Kode',
  'rail.collections': 'Koleksi',
  'rail.components': 'Komponen',
  'rail.editorPanels': 'Panel editor',
  'rail.history': 'Git', // same
  'rail.more': 'Lainnya',
  'rail.moveToBottom': 'Pindahkan ke grup bawah',
  'rail.moveToTop': 'Pindahkan ke grup atas',
  'rail.movedBottom': '{label}: grup bawah, posisi {position} dari {count}',
  'rail.movedTop': '{label}: grup atas, posisi {position} dari {count}',
  'rail.navigator': 'Navigator', // same
  'rail.orderMenu': 'Urutan rail',
  'rail.pages': 'Halaman',
  'rail.properties': 'Properti',
  'rail.reset': 'Atur ulang urutan rail',
  'rail.resetDone': 'Urutan rail diatur ulang',
  'rail.selectors': 'Selektor gaya',
  'rail.settings': 'Pengaturan',
  'rail.settingsOrder.description': 'Seret ikon di sidebar untuk mengubah urutannya. Atur ulang ke urutan default.',
  'rail.settingsOrder.done': 'Urutan sidebar diatur ulang',
  'rail.settingsOrder.label': 'Urutan ikon sidebar',
  'rail.settingsOrder.reset': 'Atur ulang ke default',
  'rail.variables': 'Variabel',
  'rail.withShortcut': '{label} ({shortcut})', // same
} as const satisfies CatalogOf<MessageKey>;
