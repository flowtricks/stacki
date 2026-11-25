// Turkish `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Bir tuval açmadan önce varsayılan düzenleyicisini kapatın.',
  'componentCanvas.error.notOpened': 'Bileşen tuvalde açılmadı. Yeniden deneyin.',
  'componentCanvas.error.notReturned': 'Bulunduğunuz dosyaya geri dönülemedi. Dosyayı Sayfalar panelinden açın.',
  'componentCanvas.error.open': 'Tuval açılamadı: {message}',
  'componentCanvas.error.save': 'Tuval ayarları kaydedilemedi: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'ayarlanmamış',
  'componentCanvas.menu.open': 'Tuvalde aç',
  'componentCanvas.notice.truncated': '{total} çerçevenin ilk {shown} tanesi gösteriliyor. Kalanları görmek için daha az prop’a ayrı çerçeve verin.',
  'componentCanvas.pageName': '{name} tuvali',
  'componentCanvas.panel.background': 'Arka plan',
  'componentCanvas.panel.fixed': 'Sabit',
  'componentCanvas.panel.frame.hint':
    'Çerçeveyi seçmek için etiketine veya bileşeninin çevresindeki boşluğa tıklayın. Bileşeni düzenlemek için içine tıklayın.',
  'componentCanvas.panel.frame.pick': 'Çerçeve',
  'componentCanvas.panel.frame.title': 'Çerçeve',
  'componentCanvas.panel.frames': {
    one: '{count} çerçeve',
    other: '{count} çerçeve',
  },
  'componentCanvas.panel.height': 'Yükseklik',
  'componentCanvas.panel.hug': 'İçeriğe göre',
  'componentCanvas.panel.pixels': 'Piksel cinsinden {side}',
  'componentCanvas.panel.props.hint':
    'Bu çerçevenin render edildiği değerler. Bu değerler tuvalde kalır ve tuvali her açtığınızda geri gelir. Bileşene veya örneklerine asla yazılmaz.',
  'componentCanvas.panel.props.none': 'Ayarlanmadı',
  'componentCanvas.panel.props.split': '{name} prop’unun her değerinin kendi çerçevesi var.',
  'componentCanvas.panel.props.title': 'Önizleme prop’ları',
  'componentCanvas.panel.props.unused': 'Bu varyant {name} prop’unu kullanmıyor.',
  'componentCanvas.panel.scope.all': 'Tüm çerçeveler',
  'componentCanvas.panel.scope.frame': 'Bu çerçeve',
  'componentCanvas.panel.scope.hint':
    'Ayarladığınız boyut, arka plan ve prop değerlerinin uygulanacağı yer: bu çerçeve, tek bir değerin tüm çerçeveleri veya tüm çerçeveler. Çerçevenin kendi ayarı, daha geniş kapsamlı ayara üstün gelir.',
  'componentCanvas.panel.scope.label': 'Uygulama kapsamı',
  'componentCanvas.panel.scope.part': 'Tüm {part} çerçeveleri',
  'componentCanvas.panel.split.hint':
    'Burada açılan bir prop’un her değeri kendi çerçevesini alır ve çerçeveler tüm birleşimleri gösterir. Kapalı bırakılan prop her çerçevede tek bir değer gösterir; bu değeri Önizleme prop’ları bölümünde ayarlarsınız.',
  'componentCanvas.panel.split.title': 'Ayrı çerçeveler',
  'componentCanvas.panel.split.toggle': '{name} prop’unun her değerine kendi çerçevesini ver',
  'componentCanvas.panel.transparent': 'Saydam',
  'componentCanvas.panel.values': {
    one: '{count} değer',
    other: '{count} değer',
  },
  'componentCanvas.panel.width': 'Genişlik',
  'componentCanvas.popup.close': 'Çerçeve ayarlarını kapat',
  'componentCanvas.popup.title': 'Çerçeve ayarları',
  'componentCanvas.titleBar.close': '{name} tuvalini kapat',
  'componentCanvas.zoom.fit': 'Sığdır',
  'componentCanvas.zoom.fitAll': 'Tüm çerçeveleri sığdıracak şekilde yakınlaştır',
  'componentCanvas.zoom.in': 'Yakınlaştır',
  'componentCanvas.zoom.out': 'Uzaklaştır',
  'componentCanvas.zoom.percent': '%{percent}',
  'componentCanvas.zoom.reset': '%100’e yakınlaştır',
} as const satisfies CatalogOf<MessageKey>;
