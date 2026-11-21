// Indonesian `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'Mengunduh…',
  'welcome.clone.downloading': 'Mengunduh repositori…',
  'welcome.clone.hint': 'Pilih folder berikutnya. Stacki mengunduh salinan lokal baru beserta riwayat Git-nya.',
  'welcome.clone.invalid': 'Masukkan repositori dalam format pemilik/nama.',
  'welcome.clone.submit': 'Pilih folder dan unduh',
  'welcome.clone.title': 'Buka dari GitHub',
  'welcome.creating': 'Membuat…',
  'welcome.hero.moreOpen': 'Cara lain untuk membuka proyek',
  'welcome.hero.moreStart': 'Cara lain untuk memulai proyek',
  'welcome.hero.openFolder': 'Buka dari folder',
  'welcome.hero.openGitHub': 'Buka dari GitHub',
  'welcome.hero.startAstro': 'Mulai dari Astro',
  'welcome.hero.startLumos': 'Mulai dari Lumos',
  'welcome.packageManager': 'Pengelola paket',
  'welcome.project.ai': 'Tambahkan file agen AI',
  'welcome.project.git': 'Inisialisasi repositori git baru',
  'welcome.project.install': 'Instal dependensi',
  'welcome.project.question': 'Bagaimana Anda ingin memulai proyek baru?',
  'welcome.project.starting': 'Memulai…',
  'welcome.project.submit': 'Buat Proyek',
  'welcome.project.title': 'Proyek Astro Baru',
  'welcome.project.tryAgain': 'Coba lagi',
  'welcome.projectCreated': 'Proyek dibuat',
  'welcome.recent.remove': 'Hapus dari proyek terbaru',
  'welcome.siteCreated': 'Situs dibuat',
  'welcome.siteName': 'Nama situs',
  'welcome.starter.note':
    'Menjalankan {command}, lalu memulai riwayat git tersendiri, sehingga saat dipublikasikan nanti yang terbit adalah situs Anda, bukan fork dari starter.',
  'welcome.starter.noteWithManager':
    'Menjalankan {command}, menginstalnya dengan {manager}, lalu memulai riwayat git tersendiri, sehingga saat dipublikasikan nanti yang terbit adalah situs Anda, bukan fork dari starter.',
  'welcome.starter.submit': 'Buat situs',
  'welcome.starter.title': 'Mulai dari Lumos',
  'welcome.starter.unfinished': 'Starter belum selesai.',
  'welcome.template.basics.hint': 'Proyek starter dasar yang praktis',
  'welcome.template.basics.label': 'Dasar',
  'welcome.template.blog.hint': 'Koleksi konten dan perutean pos',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Hanya yang esensial',
  'welcome.template.minimal.label': 'Kosong',
  'welcome.template.starlight.hint': 'Tema dokumentasi Astro',
  'welcome.template.starlight.label': 'Dokumen (Starlight)',
  'welcome.working': 'Memproses',
} as const satisfies CatalogOf<MessageKey>;
