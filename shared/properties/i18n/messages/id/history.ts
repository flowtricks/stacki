// Indonesian `history` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/history';

export const messages = {
  'history.backToNow': 'Kembali ke sekarang',
  'history.commit.actions': 'Aksi commit',
  'history.commit.merge': 'Commit merge',
  'history.commit.preview': 'Pratinjau',
  'history.commit.restoreProject': 'Pulihkan proyek ke commit ini…',
  'history.commit.you': 'Anda',
  'history.day.today': 'Hari ini',
  'history.day.yesterday': 'Kemarin',
  'history.dialog.close': 'Tutup file yang berubah',
  'history.dialog.title': 'File yang berubah ({count})',
  'history.diff.allFiles': 'Semua file',
  'history.diff.emptyTree': 'Tree kosong',
  'history.diff.firstParent': 'dibandingkan dengan parent pertama',
  'history.diff.label': 'Diff file',
  'history.diff.loading': 'Memuat diff…',
  'history.diff.noTextChanges': 'Tidak ada perubahan teks pada file ini.',
  'history.diff.restoreFile': 'Pulihkan file…',
  'history.error.diffUnreadable': 'Tidak dapat membaca diff commit ini.',
  'history.files.added': {
    other: '{count} file ditambahkan',
  },
  'history.files.changedLabel': 'file yang berubah',
  'history.files.count': {
    other: '{count} file',
  },
  'history.files.deleted': {
    other: '{count} file dihapus',
  },
  'history.files.from': 'Dari {path}',
  'history.files.listLabel': 'Daftar file yang berubah',
  'history.files.noMatch': 'Tidak ada file yang cocok dengan filter ini.',
  'history.files.none': 'Tidak ada file yang berubah.',
  'history.files.unavailable': 'File yang berubah tidak tersedia untuk commit ini.',
  'history.files.updated': {
    other: '{count} file diperbarui',
  },
  'history.files.view': 'Lihat file yang berubah ({count})',
  'history.files.viewDiff': 'Lihat diff untuk {path}',
  'history.filter.added': 'Baru',
  'history.filter.all': 'Semua',
  'history.filter.deleted': 'Dihapus',
  'history.filter.label': 'Filter file yang berubah',
  'history.filter.updated': 'Diubah',
  'history.scope.all': 'Semua branch',
  'history.scope.ariaLabel': 'Filter commit menurut branch',
  'history.scope.current': 'Branch saat ini',
  'history.scope.label': 'Filter commit',
  'history.scope.showing': 'Menampilkan commit di {branch}',
  'history.sort.ariaLabel': 'Urutkan file yang berubah',
  'history.sort.label': 'Urutkan',
  'history.sort.path': 'Path file',
  'history.sort.status': 'Status', // same
  'history.summary.moreFiles': {
    other: '{first} dan {count} file lainnya',
  },
  'history.summary.morePages': {
    other: '{first} dan {count} halaman lainnya',
  },
  'history.summary.none': 'Tidak ada file yang berubah',
  'history.summary.two': '{first} dan {second}',
  'history.time.daysAgo': {
    other: '{count} hari lalu',
  },
  'history.time.hoursAgo': {
    other: '{count} jam lalu',
  },
  'history.time.justNow': 'baru saja',
  'history.time.minutesAgo': {
    other: '{count} menit lalu',
  },
  'history.time.yesterday': 'kemarin',
  'history.timeline.empty':
    'Belum ada yang tersimpan. Setelah Anda menyimpan versi pertama, versi itu muncul di sini dan Anda dapat kembali ke sana kapan pun.',
  'history.timeline.label': 'Riwayat Git',
  'history.timeline.showOlder': 'Tampilkan yang lebih lama',
  'history.versionHistory': 'Riwayat versi',
} as const satisfies CatalogOf<MessageKey>;
