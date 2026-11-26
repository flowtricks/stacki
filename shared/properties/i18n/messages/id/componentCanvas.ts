// Indonesian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Tutup editor bawaan sebelum membuka kanvas.',
  'componentCanvas.error.notOpened': 'Komponen tidak terbuka di kanvas. Coba lagi.',
  'componentCanvas.error.notReturned': 'Tidak dapat kembali ke file sebelumnya. Buka file itu dari panel Halaman.',
  'componentCanvas.error.open': 'Kanvas tidak dapat dibuka: {message}',
  'componentCanvas.error.pageReadOnly': 'Kanvas ini hanya menampilkan komponen. Klik dua kali sebuah frame untuk mengedit komponen di dalamnya.',
  'componentCanvas.error.previewValue': 'Frame dapat mempratinjau nilai untuk {name}, bukan kode.',
  'componentCanvas.error.save': 'Pengaturan kanvas tidak dapat disimpan: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'belum diatur',
  'componentCanvas.level.all': 'Diatur untuk semua frame',
  'componentCanvas.level.frame': 'Frame ini punya nilainya sendiri',
  'componentCanvas.level.overrides': {
    other: '{count} frame di sini tetap memakai nilainya sendiri. Reset untuk memberinya nilai ini.',
  },
  'componentCanvas.level.part': 'Diatur untuk setiap frame {part}',
  'componentCanvas.menu.open': 'Buka di kanvas',
  'componentCanvas.notice.truncated': 'Menampilkan {shown} frame pertama dari {total}. Berikan frame sendiri ke lebih sedikit prop untuk melihat sisanya.',
  'componentCanvas.pageName': 'Kanvas {name}',
  'componentCanvas.panel.background': 'Latar belakang',
  'componentCanvas.panel.backgroundVariable': 'Hubungkan ke variabel',
  'componentCanvas.panel.fixed': 'Tetap',
  'componentCanvas.panel.frames': {
    other: '{count} frame',
  },
  'componentCanvas.panel.height': 'Tinggi',
  'componentCanvas.panel.hug': 'Ikuti isi',
  'componentCanvas.panel.pixels': '{side} dalam piksel',
  'componentCanvas.panel.root.about': 'Kanvas di belakang semua frame: elemen html halaman. Kelasnya ada di panel Pengaturan.',
  'componentCanvas.panel.root.title': 'Kanvas',
  'componentCanvas.panel.scope.all': 'Semua frame',
  'componentCanvas.panel.scope.component': 'Komponen ini',
  'componentCanvas.panel.scope.frame': 'Frame ini',
  'componentCanvas.panel.scope.hint':
    'Tempat berlakunya ukuran, latar belakang, dan nilai prop yang Anda atur: frame ini, setiap frame dengan satu nilai, atau semua frame. Pengaturan milik frame mengalahkan pengaturan yang lebih luas.',
  'componentCanvas.panel.scope.label': 'Terapkan ke',
  'componentCanvas.panel.scope.part': 'Setiap frame {part}',
  'componentCanvas.panel.scope.project': 'Semua komponen',
  'componentCanvas.panel.size': 'Ukuran',
  'componentCanvas.panel.transparent': 'Transparan',
  'componentCanvas.panel.width': 'Lebar',
  'componentCanvas.popup.expand': 'Perluas pengaturan frame',
  'componentCanvas.popup.minimize': 'Ciutkan pengaturan frame',
  'componentCanvas.popup.title': 'Pengaturan frame',
  'componentCanvas.scope.valueFrames': 'Semua frame {value}',
  'componentCanvas.split.full': 'Maksimal {max} prop dapat memiliki frame sendiri. Nonaktifkan salah satunya terlebih dahulu.',
  'componentCanvas.split.locked': 'Setiap nilai {name} memiliki frame sendiri.',
  'componentCanvas.split.off': {
    other: 'Berikan frame sendiri ke setiap nilai {name} ({count} nilai)',
  },
  'componentCanvas.split.on': 'Tampilkan {name} dalam satu frame',
  'componentCanvas.titleBar.close': 'Tutup kanvas {name}',
  'componentCanvas.zoom.fit': 'Pas',
  'componentCanvas.zoom.fitAll': 'Zoom agar semua frame pas',
  'componentCanvas.zoom.in': 'Perbesar',
  'componentCanvas.zoom.out': 'Perkecil',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom ke 100%',
} as const satisfies CatalogOf<MessageKey>;
