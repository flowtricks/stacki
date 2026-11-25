// Brazilian Portuguese `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'Feche o editor de padrões antes de abrir um canvas.',
  'componentCanvas.error.notOpened': 'O componente não abriu no canvas. Tente novamente.',
  'componentCanvas.error.notReturned': 'Não foi possível voltar ao arquivo em que você estava. Abra-o no painel Páginas.',
  'componentCanvas.error.open': 'Não foi possível abrir o canvas: {message}',
  'componentCanvas.error.pageReadOnly': 'Este canvas apenas mostra o componente. Clique duas vezes em um quadro para editar o componente dentro dele.',
  'componentCanvas.error.previewValue': 'Um quadro pode pré-visualizar texto, um número ou ligado e desligado para {name}, mas não código.',
  'componentCanvas.error.save': 'Não foi possível salvar as configurações do canvas: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'não definido',
  'componentCanvas.framePanel.hide': 'Ocultar configurações do quadro',
  'componentCanvas.framePanel.show': 'Mostrar configurações do quadro',
  'componentCanvas.menu.open': 'Abrir no canvas',
  'componentCanvas.notice.truncated': 'Mostrando os primeiros {shown} de {total} quadros. Dê quadros próprios a menos props para ver o restante.',
  'componentCanvas.pageName': 'Canvas de {name}',
  'componentCanvas.panel.background': 'Plano de fundo',
  'componentCanvas.panel.backgroundVariable': 'Conectar a uma variável',
  'componentCanvas.panel.fixed': 'Fixo',
  'componentCanvas.panel.frame.about': 'Clique em um quadro para selecionar o componente dele e clique duas vezes para editar o componente dentro dele.',
  'componentCanvas.panel.frame.pick': 'Quadro',
  'componentCanvas.panel.frame.title': 'Quadro',
  'componentCanvas.panel.frames': {
    one: '{count} quadro',
    other: '{count} quadros',
  },
  'componentCanvas.panel.height': 'Altura',
  'componentCanvas.panel.hug': 'Ao conteúdo',
  'componentCanvas.panel.pixels': '{side} em pixels',
  'componentCanvas.panel.scope.all': 'Todos os quadros',
  'componentCanvas.panel.scope.frame': 'Este quadro',
  'componentCanvas.panel.scope.hint':
    'Onde se aplicam o tamanho, o plano de fundo e os valores de props que você definir: neste quadro, em todos os quadros de um valor ou em todos os quadros. A configuração do próprio quadro prevalece sobre uma mais ampla.',
  'componentCanvas.panel.scope.label': 'Aplicar a',
  'componentCanvas.panel.scope.part': 'Todos os quadros de {part}',
  'componentCanvas.panel.scope.project': 'Todos os componentes',
  'componentCanvas.panel.transparent': 'Transparente',
  'componentCanvas.panel.width': 'Largura',
  'componentCanvas.popup.close': 'Fechar configurações do quadro',
  'componentCanvas.popup.title': 'Configurações do quadro',
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
