// Brazilian Portuguese `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Feche o editor de padrões antes de abrir um canvas.',
  'componentCanvas.error.notOpened': 'O componente não abriu no canvas. Tente novamente.',
  'componentCanvas.error.notReturned': 'Não foi possível voltar ao arquivo em que você estava. Abra-o no painel Páginas.',
  'componentCanvas.error.open': 'Não foi possível abrir o canvas: {message}',
  'componentCanvas.error.pageReadOnly': 'Este canvas apenas mostra o componente. Clique duas vezes em um quadro para editar o componente dentro dele.',
  'componentCanvas.error.previewValue': 'Um quadro pode pré-visualizar um valor para {name}, mas não código.',
  'componentCanvas.error.save': 'Não foi possível salvar as configurações do canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'não definido',
  'componentCanvas.level.all': 'Definido para todos os quadros',
  'componentCanvas.level.defaults': 'Definido nos padrões do componente (Definir padrões do componente). Defina um valor aqui para substituí-lo.',
  'componentCanvas.level.frame': 'Este quadro tem seu próprio valor',
  'componentCanvas.level.mixed': {
    one: 'O {count} quadro aqui mostra um valor diferente. Um valor definido aqui vai para todos os quadros daqui.',
    other: 'Os {count} quadros aqui mostram valores diferentes. Um valor definido aqui vai para todos eles.',
  },
  'componentCanvas.level.overrides': {
    one: '{count} quadro aqui mantém o próprio valor. Redefina para dar a ele este valor.',
    other: '{count} quadros aqui mantêm o próprio valor. Redefina para dar a eles este valor.',
  },
  'componentCanvas.level.part': 'Definido para cada quadro {part}',
  'componentCanvas.level.sample': 'Um exemplo que o canvas dá a esta prop obrigatória. Defina um valor aqui para substituí-lo.',
  'componentCanvas.menu.open': 'Abrir no canvas',
  'componentCanvas.notice.truncated': 'Mostrando os primeiros {shown} de {total} quadros. Dê quadros próprios a menos props para ver o restante.',
  'componentCanvas.pageName': 'Canvas de {name}',
  'componentCanvas.panel.background': 'Plano de fundo',
  'componentCanvas.panel.backgroundVariable': 'Conectar a uma variável',
  'componentCanvas.panel.fixed': 'Fixo',
  'componentCanvas.panel.frames': {
    one: '{count} quadro',
    other: '{count} quadros',
  },
  'componentCanvas.panel.height': 'Altura',
  'componentCanvas.panel.hug': 'Ao conteúdo',
  'componentCanvas.panel.layout': 'Layout', // same
  'componentCanvas.panel.layout.column': 'Empilhados',
  'componentCanvas.panel.layout.row': 'Lado a lado',
  'componentCanvas.panel.layout.wrap': 'Quebrar linha',
  'componentCanvas.panel.mixed': 'Misto',
  'componentCanvas.panel.pixels': '{side} em pixels',
  'componentCanvas.panel.root.about': 'O canvas atrás de todos os quadros: o elemento html da página. As classes dele ficam no painel de configurações.',
  'componentCanvas.panel.root.title': 'Canvas', // same
  'componentCanvas.panel.scope.all': 'Todos os quadros',
  'componentCanvas.panel.scope.component': 'Este componente',
  'componentCanvas.panel.scope.frame': 'Este quadro',
  'componentCanvas.panel.scope.hint':
    'Onde se aplicam o tamanho, o plano de fundo e os valores de props que você definir: neste quadro, em todos os quadros de um valor ou em todos os quadros. A configuração do próprio quadro prevalece sobre uma mais ampla.',
  'componentCanvas.panel.scope.label': 'Aplicar a',
  'componentCanvas.panel.scope.part': 'Todos os quadros de {part}',
  'componentCanvas.panel.scope.project': 'Todos os componentes',
  'componentCanvas.panel.size': 'Tamanho',
  'componentCanvas.panel.transparent': 'Transparente',
  'componentCanvas.panel.width': 'Largura',
  'componentCanvas.popup.expand': 'Expandir configurações do quadro',
  'componentCanvas.popup.minimize': 'Minimizar configurações do quadro',
  'componentCanvas.popup.title': 'Configurações do quadro',
  'componentCanvas.scope.valueFrames': 'Todos os quadros de {value}',
  'componentCanvas.split.full': 'Até {max} props podem ter quadros próprios. Desative uma primeiro.',
  'componentCanvas.split.locked': 'Cada valor de {name} tem seu próprio quadro.',
  'componentCanvas.split.off': {
    one: 'Dar a cada valor de {name} seu próprio quadro ({count} valor)',
    other: 'Dar a cada valor de {name} seu próprio quadro ({count} valores)',
  },
  'componentCanvas.split.on': 'Mostrar {name} em um só quadro',
  'componentCanvas.titleBar.close': 'Fechar o canvas de {name}',
  'componentCanvas.zoom.fit': 'Ajustar',
  'componentCanvas.zoom.fitAll': 'Ajustar o zoom para ver todos os quadros',
  'componentCanvas.zoom.in': 'Aumentar zoom',
  'componentCanvas.zoom.out': 'Diminuir zoom',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': 'Zoom de 100%',
} as const satisfies CatalogOf<MessageKey>;
