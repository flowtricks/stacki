// Brazilian Portuguese `emdash` strings (EmDash support). Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/emdash';

export const messages = {
  'emdash.absent.create': 'Comece um site novo com o modelo inicial do EmDash:',
  'emdash.absent.hint':
    'O Stacki detecta o EmDash pelo próprio projeto: o pacote emdash, sua integração com o Astro e a coleção ao vivo _emdash. Adicione-os e reabra as configurações.',
  'emdash.absent.title': 'O EmDash não está configurado neste projeto',
  'emdash.binding.boolean': 'Sim/Não',
  'emdash.binding.data': 'Dados',
  'emdash.binding.date': 'Data',
  'emdash.binding.file': 'Arquivo',
  'emdash.binding.image': 'Imagem',
  'emdash.binding.link': 'Link', // same
  'emdash.binding.list': 'Lista',
  'emdash.binding.number': 'Número',
  'emdash.binding.reference': 'Referência',
  'emdash.binding.richText': 'Texto formatado',
  'emdash.binding.text': 'Texto',
  'emdash.button.connected': 'Configurado',
  'emdash.field.required': 'obrigatório',
  'emdash.field.unsupported': 'Tipo desconhecido',
  'emdash.guide.analyze': 'Confira o que será importado (o site local precisa estar vazio):',
  'emdash.guide.export': 'Exporte o site do cliente. Isso apenas lê dele:',
  'emdash.guide.import': 'Importe na sua cópia local:',
  'emdash.guide.login': 'Entre no site EmDash do cliente:',
  'emdash.guide.safe':
    'O banco de dados local e os uploads ficam neste computador e nunca são publicados. Só o cliente altera o conteúdo, no próprio painel do EmDash.',
  'emdash.guide.title': 'Prévia com o conteúdo real do cliente',
  'emdash.hint.definedInEmDash':
    'Os tipos de conteúdo e os campos são definidos apenas no EmDash. Altere-os no painel dele; o Stacki só os lê e nunca os edita.',
  'emdash.output.server': 'sob demanda (servidor)',
  'emdash.output.static': 'na compilação (estático)',
  'emdash.output.unknown': 'não definido na configuração',
  'emdash.problem.databaseTracked': 'O banco de dados local não está no .gitignore. Adicione-o para que uma publicação nunca leve seu conteúdo local.',
  'emdash.problem.databaseUnreadable':
    'Não foi possível ler o banco de dados local. Pare o servidor de desenvolvimento se ele estiver migrando e reabra as configurações.',
  'emdash.problem.noDatabase': 'Ainda não há banco de dados local. Execute o servidor de desenvolvimento uma vez e conclua a configuração em /_emdash/admin.',
  'emdash.problem.noIntegration': 'Adicione a integração emdash() de emdash/astro ao astro.config.',
  'emdash.problem.noLiveCollection': 'Registre a coleção ao vivo _emdash em src/live.config.ts com emdashLoader().',
  'emdash.problem.noSchema': 'Ainda não há tipos de conteúdo. Crie-os no painel do EmDash ou execute emdash types para salvar um arquivo de esquema.',
  'emdash.problem.notInstalled': 'Instale o pacote emdash (npm install emdash).',
  'emdash.problem.schemaUnreadable': 'Não foi possível ler o arquivo de esquema. Execute emdash types novamente.',
  'emdash.problem.staticOutput': 'O EmDash lê o conteúdo quando uma página é solicitada. Defina output como server e adicione um adaptador no astro.config.',
  'emdash.problem.uploadsTracked': 'A pasta de uploads não está no .gitignore. Adicione-a para que a mídia nunca viaje com o seu código.',
  'emdash.schema.database': 'Lido do banco de dados local do EmDash',
  'emdash.schema.schemaJson': 'Lido de .emdash/schema.json',
  'emdash.schema.seed': 'Lido do arquivo seed',
  'emdash.status.collections': 'Tipos de conteúdo',
  'emdash.status.database': 'Banco de dados local',
  'emdash.status.output': 'As páginas são renderizadas',
  'emdash.template.collection': 'Tipo de conteúdo',
  'emdash.template.create': 'Criar modelo',
  'emdash.template.empty': 'Nenhum tipo de conteúdo. Defina-os primeiro no EmDash.',
  'emdash.template.layout': 'Layout', // same
  'emdash.template.menu': 'Modelo de página do EmDash',
  'emdash.template.noLayout': 'Sem layout',
  'emdash.template.noSuchCollection': 'O projeto EmDash não tem nenhum tipo de conteúdo chamado “{collection}”.',
  'emdash.template.notEmDash': 'Este projeto ainda não usa o EmDash.',
  'emdash.template.route': 'Endereço da página',
  'emdash.template.routeHint': 'Cada entrada do EmDash tem a própria página neste endereço, sempre com o conteúdo atual.',
  'emdash.template.title': 'Novo modelo de página do EmDash',
  'emdash.title': 'EmDash', // same
  'emdash.unavailable': 'O EmDash é lido da pasta do projeto, então por enquanto só está disponível no Stacki Desktop.',
} as const satisfies CatalogOf<MessageKey>;
