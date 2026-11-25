// Indonesian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Tutup editor bawaan sebelum membuka kanvas.',
  'componentCanvas.error.notOpened': 'Komponen tidak terbuka di kanvas. Coba lagi.',
  'componentCanvas.error.notReturned': 'Tidak dapat kembali ke file sebelumnya. Buka file itu dari panel Halaman.',
  'componentCanvas.error.open': 'Kanvas tidak dapat dibuka: {message}',
  'componentCanvas.error.save': 'Pengaturan kanvas tidak dapat disimpan: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'belum diatur',
  'componentCanvas.menu.open': 'Buka di kanvas',
  'componentCanvas.notice.truncated': 'Menampilkan {shown} frame pertama dari {total}. Berikan frame sendiri ke lebih sedikit prop untuk melihat sisanya.',
  'componentCanvas.pageName': 'Kanvas {name}',
  'componentCanvas.panel.background': 'Latar belakang',
  'componentCanvas.panel.fixed': 'Tetap',
  'componentCanvas.panel.frame.hint': 'Klik label frame atau ruang di sekitar komponennya untuk memilih frame. Klik di dalam komponen untuk mengeditnya.',
  'componentCanvas.panel.frame.pick': 'Frame', // same
  'componentCanvas.panel.frame.title': 'Frame', // same
  'componentCanvas.panel.frames': {
    other: '{count} frame',
  },
  'componentCanvas.panel.height': 'Tinggi',
  'componentCanvas.panel.hug': 'Ikuti isi',
  'componentCanvas.panel.pixels': '{side} dalam piksel',
  'componentCanvas.panel.props.hint':
    'Nilai yang dipakai frame ini saat dirender. Nilai ini tetap di kanvas dan kembali setiap kali Anda membukanya. Nilai ini tidak pernah ditulis ke komponen atau instance-nya.',
  'componentCanvas.panel.props.none': 'Belum diatur',
  'componentCanvas.panel.props.split': 'Setiap nilai {name} memiliki frame sendiri.',
  'componentCanvas.panel.props.title': 'Prop pratinjau',
  'componentCanvas.panel.props.unused': 'Varian ini tidak memakai {name}.',
  'componentCanvas.panel.scope.all': 'Semua frame',
  'componentCanvas.panel.scope.frame': 'Frame ini',
  'componentCanvas.panel.scope.hint':
    'Tempat berlakunya ukuran, latar belakang, dan nilai prop yang Anda atur: frame ini, setiap frame dengan satu nilai, atau semua frame. Pengaturan milik frame mengalahkan pengaturan yang lebih luas.',
  'componentCanvas.panel.scope.label': 'Terapkan ke',
  'componentCanvas.panel.scope.part': 'Setiap frame {part}',
  'componentCanvas.panel.split.hint':
    'Setiap nilai dari prop yang diaktifkan di sini mendapat frame sendiri, dan frame menampilkan semua kombinasi. Prop yang dinonaktifkan menampilkan satu nilai per frame, yang Anda atur di Prop pratinjau.',
  'componentCanvas.panel.split.title': 'Frame sendiri',
  'componentCanvas.panel.split.toggle': 'Berikan frame sendiri untuk setiap nilai {name}',
  'componentCanvas.panel.transparent': 'Transparan',
  'componentCanvas.panel.values': {
    other: '{count} nilai',
  },
  'componentCanvas.panel.width': 'Lebar',
  'componentCanvas.popup.close': 'Tutup pengaturan frame',
  'componentCanvas.popup.title': 'Pengaturan frame',
  'componentCanvas.titleBar.close': 'Tutup kanvas {name}',
  'componentCanvas.zoom.fit': 'Pas',
  'componentCanvas.zoom.fitAll': 'Zoom agar semua frame pas',
  'componentCanvas.zoom.in': 'Perbesar',
  'componentCanvas.zoom.out': 'Perkecil',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom ke 100%',
} as const satisfies CatalogOf<MessageKey>;
