// Brazilian Portuguese `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Feche o editor de padrões antes de abrir um canvas.',
  'componentCanvas.error.notOpened': 'O componente não abriu no canvas. Tente novamente.',
  'componentCanvas.error.notReturned': 'Não foi possível voltar ao arquivo em que você estava. Abra-o no painel Páginas.',
  'componentCanvas.error.open': 'Não foi possível abrir o canvas: {message}',
  'componentCanvas.error.save': 'Não foi possível salvar as configurações do canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'não definido',
  'componentCanvas.menu.open': 'Abrir canvas',
  'componentCanvas.notice.truncated': 'Mostrando os primeiros {shown} de {total} quadros. Dê quadros próprios a menos props para ver o restante.',
  'componentCanvas.pageName': 'Canvas de {name}',
  'componentCanvas.panel.background': 'Plano de fundo',
  'componentCanvas.panel.fixed': 'Fixo',
  'componentCanvas.panel.frame.hint':
    'Clique no rótulo de um quadro ou no espaço ao redor do componente para selecionar o quadro. Clique dentro do componente para editá-lo.',
  'componentCanvas.panel.frame.pick': 'Quadro',
  'componentCanvas.panel.frame.title': 'Quadro',
  'componentCanvas.panel.frames': {
    one: '{count} quadro',
    other: '{count} quadros',
  },
  'componentCanvas.panel.height': 'Altura',
  'componentCanvas.panel.hug': 'Ao conteúdo',
  'componentCanvas.panel.pixels': '{side} em pixels',
  'componentCanvas.panel.props.hint':
    'Os valores com que este quadro é renderizado. Eles ficam no canvas e voltam sempre que você o abre. Nunca são gravados no componente nem nas instâncias dele.',
  'componentCanvas.panel.props.none': 'Não definido',
  'componentCanvas.panel.props.split': 'Cada valor de {name} tem seu próprio quadro.',
  'componentCanvas.panel.props.title': 'Props de visualização',
  'componentCanvas.panel.props.unused': 'Esta variante não usa {name}.',
  'componentCanvas.panel.scope.all': 'Todos os quadros',
  'componentCanvas.panel.scope.frame': 'Este quadro',
  'componentCanvas.panel.scope.hint':
    'Onde se aplicam o tamanho, o plano de fundo e os valores de props que você definir: neste quadro, em todos os quadros de um valor ou em todos os quadros. A configuração do próprio quadro prevalece sobre uma mais ampla.',
  'componentCanvas.panel.scope.label': 'Aplicar a',
  'componentCanvas.panel.scope.part': 'Todos os quadros de {part}',
  'componentCanvas.panel.split.hint':
    'Cada valor de uma prop ativada aqui ganha seu próprio quadro, e os quadros mostram todas as combinações. Uma prop desativada mostra um valor por quadro, que você define em Props de visualização.',
  'componentCanvas.panel.split.title': 'Quadros próprios',
  'componentCanvas.panel.split.toggle': 'Dar a cada valor de {name} seu próprio quadro',
  'componentCanvas.panel.transparent': 'Transparente',
  'componentCanvas.panel.values': {
    one: '{count} valor',
    other: '{count} valores',
  },
  'componentCanvas.panel.width': 'Largura',
  'componentCanvas.titleBar.close': 'Fechar o canvas de {name}',
  'componentCanvas.zoom.fit': 'Ajustar',
  'componentCanvas.zoom.fitAll': 'Ajustar o zoom para ver todos os quadros',
  'componentCanvas.zoom.in': 'Aumentar zoom',
  'componentCanvas.zoom.out': 'Diminuir zoom',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom de 100%',
} as const satisfies CatalogOf<MessageKey>;
