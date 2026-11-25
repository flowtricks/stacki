// Russian `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Закройте редактор значений по умолчанию, прежде чем открывать холст.',
  'componentCanvas.error.notOpened': 'Компонент не открылся на холсте. Попробуйте снова.',
  'componentCanvas.error.notReturned': 'Не удалось вернуться к файлу, в котором вы были. Откройте его из панели «Страницы».',
  'componentCanvas.error.open': 'Не удалось открыть холст: {message}',
  'componentCanvas.error.save': 'Не удалось сохранить настройки холста: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'не задано',
  'componentCanvas.menu.open': 'Открыть холст',
  'componentCanvas.notice.truncated': 'Показаны первые фреймы: {shown} из {total}. Чтобы увидеть остальные, выделите отдельные фреймы меньшему числу свойств.',
  'componentCanvas.pageName': 'Холст {name}',
  'componentCanvas.panel.background': 'Фон',
  'componentCanvas.panel.fixed': 'Фиксированный',
  'componentCanvas.panel.frame.hint':
    'Щёлкните подпись фрейма или пространство вокруг компонента, чтобы выбрать фрейм. Щёлкните внутри компонента, чтобы редактировать его.',
  'componentCanvas.panel.frame.pick': 'Фрейм',
  'componentCanvas.panel.frame.title': 'Фрейм',
  'componentCanvas.panel.frames': {
    one: '{count} фрейм',
    few: '{count} фрейма',
    many: '{count} фреймов',
    other: '{count} фрейма',
  },
  'componentCanvas.panel.height': 'Высота',
  'componentCanvas.panel.hug': 'По содержимому',
  'componentCanvas.panel.pixels': '{side} в пикселях',
  'componentCanvas.panel.props.hint':
    'С чем рендерится этот фрейм. Эти значения остаются на холсте и возвращаются при каждом его открытии. Они никогда не записываются в компонент и его экземпляры.',
  'componentCanvas.panel.props.none': 'Не задано',
  'componentCanvas.panel.props.split': 'У каждого значения свойства {name} есть свой фрейм.',
  'componentCanvas.panel.props.title': 'Свойства предпросмотра',
  'componentCanvas.panel.props.unused': 'Этот вариант не использует свойство {name}.',
  'componentCanvas.panel.scope.all': 'Все фреймы',
  'componentCanvas.panel.scope.frame': 'Этот фрейм',
  'componentCanvas.panel.scope.hint':
    'Где действуют заданные вами размер, фон и значения свойств: в этом фрейме, во всех фреймах одного значения или во всех фреймах. Собственная настройка фрейма важнее более общей.',
  'componentCanvas.panel.scope.label': 'Применить к',
  'componentCanvas.panel.scope.part': 'Все фреймы {part}',
  'componentCanvas.panel.split.hint':
    'Каждое значение включённого здесь свойства получает свой фрейм, и фреймы показывают все сочетания. Выключенное свойство показывает в каждом фрейме одно значение, которое задаётся в свойствах предпросмотра.',
  'componentCanvas.panel.split.title': 'Отдельные фреймы',
  'componentCanvas.panel.split.toggle': 'Выделить каждому значению свойства {name} отдельный фрейм',
  'componentCanvas.panel.transparent': 'Прозрачный',
  'componentCanvas.panel.values': {
    one: '{count} значение',
    few: '{count} значения',
    many: '{count} значений',
    other: '{count} значения',
  },
  'componentCanvas.panel.width': 'Ширина',
  'componentCanvas.titleBar.close': 'Закрыть холст {name}',
  'componentCanvas.zoom.fit': 'Вписать',
  'componentCanvas.zoom.fitAll': 'Масштабировать, чтобы вписать все фреймы',
  'componentCanvas.zoom.in': 'Увеличить',
  'componentCanvas.zoom.out': 'Уменьшить',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Масштаб 100%',
} as const satisfies CatalogOf<MessageKey>;
