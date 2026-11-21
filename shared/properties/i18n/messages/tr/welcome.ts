// Turkish `welcome` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/welcome';

export const messages = {
  'welcome.clone.busy': 'İndiriliyor…',
  'welcome.clone.downloading': 'Depo indiriliyor…',
  'welcome.clone.hint': 'Sonra bir klasör seçin. Stacki, Git geçmişiyle birlikte yeni bir yerel kopya indirir.',
  'welcome.clone.invalid': 'Bir depoyu sahip/ad biçiminde girin.',
  'welcome.clone.submit': 'Klasör seç ve indir',
  'welcome.clone.title': 'GitHub’dan aç',
  'welcome.creating': 'Oluşturuluyor…',
  'welcome.hero.moreOpen': 'Proje açmanın diğer yolları',
  'welcome.hero.moreStart': 'Proje başlatmanın diğer yolları',
  'welcome.hero.openFolder': 'Klasörden aç',
  'welcome.hero.openGitHub': 'GitHub’dan aç',
  'welcome.hero.startAstro': 'Astro ile başla',
  'welcome.hero.startLumos': 'Lumos ile başla',
  'welcome.packageManager': 'Paket yöneticisi',
  'welcome.project.ai': 'AI ajan dosyalarını ekle',
  'welcome.project.git': 'Yeni bir git deposu başlat',
  'welcome.project.install': 'Bağımlılıkları yükle',
  'welcome.project.question': 'Yeni projenize nasıl başlamak istersiniz?',
  'welcome.project.starting': 'Başlatılıyor…',
  'welcome.project.submit': 'Proje oluştur',
  'welcome.project.title': 'Yeni Astro projesi',
  'welcome.project.tryAgain': 'Tekrar dene',
  'welcome.projectCreated': 'Proje oluşturuldu',
  'welcome.recent.remove': 'Son projelerden kaldır',
  'welcome.siteCreated': 'Site oluşturuldu',
  'welcome.siteName': 'Site adı',
  'welcome.starter.note':
    '{command} komutunu çalıştırır, ardından kendi git geçmişini başlatır — böylece daha sonra yayımladığınızda başlangıç şablonunun bir çatalını değil sitenizi yayımlarsınız.',
  'welcome.starter.noteWithManager':
    '{command} komutunu çalıştırır, {manager} ile yükler, ardından kendi git geçmişini başlatır — böylece daha sonra yayımladığınızda başlangıç şablonunun bir çatalını değil sitenizi yayımlarsınız.',
  'welcome.starter.submit': 'Site oluştur',
  'welcome.starter.title': 'Lumos ile başla',
  'welcome.starter.unfinished': 'Başlangıç şablonu tamamlanamadı.',
  'welcome.template.basics.hint': 'Basit, işe yarar bir başlangıç projesi',
  'welcome.template.basics.label': 'Temel',
  'welcome.template.blog.hint': 'İçerik koleksiyonları ve yazı yönlendirme',
  'welcome.template.blog.label': 'Blog', // same
  'welcome.template.minimal.hint': 'Yalnızca temel öğeler',
  'welcome.template.minimal.label': 'Boş',
  'welcome.template.starlight.hint': 'Astro’nun dokümantasyon teması',
  'welcome.template.starlight.label': 'Dokümanlar (Starlight)',
  'welcome.working': 'Çalışıyor',
} as const satisfies CatalogOf<MessageKey>;
