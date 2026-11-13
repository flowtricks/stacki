// Brazilian Portuguese `structure` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/structure';

export const messages = {
  'structure.collapseAll': 'Recolher tudo',
  'structure.dragHere': 'Arraste componentes para cá',
  'structure.error.needsDeveloper': 'Esta página precisa que um desenvolvedor corrija o código-fonte antes de editar.',
  'structure.error.openCode': 'Abrir painel de código',
  'structure.error.syntax': 'Esta página contém um erro de sintaxe.',
  'structure.error.syntaxNear': '{message} Perto de {near}',
  'structure.expandAll': 'Expandir tudo',
  'structure.frontmatter': 'Frontmatter', // same
  'structure.imports': { one: '1 importação', other: '{count} importações' },
  'structure.menu.convertTo': 'Converter em',
  'structure.menu.copy': 'Copiar',
  'structure.menu.cut': 'Recortar',
  'structure.menu.delete': 'Excluir',
  'structure.menu.duplicate': 'Duplicar',
  'structure.menu.label': 'Ações do elemento',
  'structure.menu.openComponent': 'Abrir componente',
  'structure.menu.paste': 'Colar',
  'structure.menu.setDefaults': 'Definir padrões do componente',
  'structure.menu.wrapIn': 'Envolver em',
  'structure.missing.injected':
    '{route} vem de {from}, não deste projeto: pode ser visualizada aqui, mas sua marcação está em uma dependência e não é editável.',
  'structure.missing.integration': 'uma integração',
  'structure.missing.select': 'Selecione uma página para editar.',
  'structure.row.imported': 'Importado de {file}',
  'structure.status.empty': 'Não renderiza nada na página com as props atuais',
  'structure.status.hidden': 'display: none — está na página, mas não é desenhado',
  'structure.status.inert': 'pointer-events: none — é desenhado, mas não recebe cliques',
} as const satisfies CatalogOf<MessageKey>;
