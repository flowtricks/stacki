// Indonesian `menu` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/menu';

export const messages = {
  'menu.app.about': 'Tentang Stacki',
  'menu.app.hide': 'Sembunyikan Stacki',
  'menu.app.hideOthers': 'Sembunyikan yang Lain',
  'menu.app.quit': 'Keluar dari Stacki',
  'menu.app.services': 'Layanan',
  'menu.app.showAll': 'Tampilkan Semua',
  'menu.edit.copy': 'Salin',
  'menu.edit.copySelection': 'Salin Pilihan',
  'menu.edit.cut': 'Potong',
  'menu.edit.insertElement': 'Sisipkan Elemen…',
  'menu.edit.paste': 'Tempel',
  'menu.edit.redo': 'Ulangi',
  'menu.edit.selectAll': 'Pilih Semua',
  'menu.edit.title': 'Edit', // same
  'menu.edit.undo': 'Urungkan',
  'menu.file.checkForUpdates': 'Periksa Pembaruan…',
  'menu.file.closeProject': 'Tutup Proyek',
  'menu.file.closeWindow': 'Tutup Jendela',
  'menu.file.openProject': 'Buka Proyek…',
  'menu.file.quit': 'Keluar',
  'menu.file.settings': 'Pengaturan…',
  'menu.file.title': 'Berkas',
  'menu.view.actualSize': 'Ukuran Sebenarnya',
  'menu.view.forceReload': 'Muat Ulang Paksa',
  'menu.view.fullScreen': 'Layar Penuh',
  'menu.view.reload': 'Muat Ulang',
  'menu.view.reloadAllCode': 'Muat Ulang Semua Kode',
  'menu.view.reloadWindow': 'Muat Ulang Jendela Saja',
  'menu.view.title': 'Tampilan',
  'menu.view.toggleDevTools': 'Alat Pengembang',
  'menu.view.zoomIn': 'Perbesar',
  'menu.view.zoomOut': 'Perkecil',
  'menu.window.bringAllToFront': 'Bawa Semua ke Depan',
  'menu.window.close': 'Tutup',
  'menu.window.minimize': 'Minimalkan',
  'menu.window.title': 'Jendela',
  'menu.window.zoom': 'Zoom', // same
} as const satisfies CatalogOf<MessageKey>;
