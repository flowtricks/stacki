// Brazilian Portuguese `history` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/history';

export const messages = {
  'history.backToNow': 'Voltar para agora',
  'history.commit.actions': 'Ações do commit',
  'history.commit.merge': 'Commit de merge', // review
  'history.commit.preview': 'Prévia',
  'history.commit.restoreProject': 'Restaurar o projeto para este commit…', // review
  'history.commit.you': 'Você',
  'history.day.today': 'Hoje',
  'history.day.yesterday': 'Ontem',
  'history.dialog.close': 'Fechar arquivos alterados',
  'history.dialog.title': 'Arquivos alterados ({count})',
  'history.diff.allFiles': 'Todos os arquivos',
  'history.diff.emptyTree': 'Árvore vazia', // review
  'history.diff.firstParent': 'comparado com o primeiro pai', // review
  'history.diff.label': 'Diferenças do arquivo',
  'history.diff.loading': 'Carregando diferenças…',
  'history.diff.noTextChanges': 'Nenhuma alteração de texto neste arquivo.',
  'history.diff.restoreFile': 'Restaurar arquivo…',
  'history.error.diffTooLarge': 'O diff deste arquivo é grande demais para ser exibido.',
  'history.error.diffTooManyLines': 'O diff deste arquivo tem linhas demais para ser exibido.',
  'history.error.diffUnreadable': 'Não foi possível ler o diff deste commit.',
  'history.files.added': {
    one: '{count} arquivo adicionado',
    other: '{count} arquivos adicionados',
  },
  'history.files.changedLabel': 'arquivos alterados',
  'history.files.count': {
    one: '{count} arquivo',
    other: '{count} arquivos',
  },
  'history.files.deleted': {
    one: '{count} arquivo excluído',
    other: '{count} arquivos excluídos',
  },
  'history.files.from': 'De {path}',
  'history.files.listLabel': 'Lista de arquivos alterados',
  'history.files.noMatch': 'Nenhum arquivo corresponde a este filtro.',
  'history.files.none': 'Nenhum arquivo alterado.',
  'history.files.unavailable': 'Os arquivos alterados não estão disponíveis para este commit.',
  'history.files.updated': {
    one: '{count} arquivo atualizado',
    other: '{count} arquivos atualizados',
  },
  'history.files.view': 'Ver arquivos alterados ({count})',
  'history.files.viewDiff': 'Ver diferenças de {path}',
  'history.filter.added': 'Novos',
  'history.filter.all': 'Todos',
  'history.filter.deleted': 'Excluídos',
  'history.filter.label': 'Filtrar arquivos alterados',
  'history.filter.updated': 'Alterados',
  'history.scope.all': 'Todas as branches',
  'history.scope.ariaLabel': 'Filtrar commits por branch',
  'history.scope.current': 'Branch atual',
  'history.scope.label': 'Filtrar commits',
  'history.scope.showing': 'Mostrando commits em {branch}',
  'history.sort.ariaLabel': 'Ordenar arquivos alterados',
  'history.sort.label': 'Ordenar',
  'history.sort.path': 'Caminho do arquivo',
  'history.sort.status': 'Status', // same
  'history.summary.moreFiles': {
    one: '{first} e mais {count} arquivo',
    other: '{first} e mais {count} arquivos',
  },
  'history.summary.morePages': {
    one: '{first} e mais {count} página',
    other: '{first} e mais {count} páginas',
  },
  'history.summary.none': 'Nenhum arquivo alterado',
  'history.summary.two': '{first} e {second}',
  'history.time.daysAgo': {
    one: 'há {count} dia',
    other: 'há {count} dias',
  },
  'history.time.hoursAgo': {
    one: 'há {count} hora',
    other: 'há {count} horas',
  },
  'history.time.justNow': 'agora mesmo',
  'history.time.minutesAgo': {
    one: 'há {count} minuto',
    other: 'há {count} minutos',
  },
  'history.time.yesterday': 'ontem',
  'history.timeline.empty': 'Nada salvo ainda. Quando você salvar sua primeira versão, ela aparecerá aqui e você poderá voltar a ela quando quiser.',
  'history.timeline.label': 'Histórico do Git',
  'history.timeline.showOlder': 'Mostrar anteriores',
  'history.versionHistory': 'Histórico de versões',
} as const satisfies CatalogOf<MessageKey>;
