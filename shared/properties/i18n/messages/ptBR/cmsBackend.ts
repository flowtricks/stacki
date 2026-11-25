// Brazilian Portuguese `cmsBackend` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/cmsBackend';

export const messages = {
  'cmsBackend.body.description': 'O Markdown da entrada, abaixo do frontmatter.',
  'cmsBackend.body.title': 'Corpo',
  'cmsBackend.config.collectionExists': 'Já existe uma coleção chamada “{name}”.',
  'cmsBackend.config.collectionsNotClosed': 'A exportação collections da configuração de conteúdo não está fechada.',
  'cmsBackend.config.nameUsed': '“{name}” já é usado na configuração de conteúdo.',
  'cmsBackend.config.noCollections': 'O Stacki não encontrou `export const collections = {{ … }}` na configuração de conteúdo.',
  'cmsBackend.config.notListed': '{collection} não está nas coleções da configuração de conteúdo.',
  'cmsBackend.config.tooLarge': 'A configuração de conteúdo é grande demais para editar aqui.',
  'cmsBackend.connection.cannotTest': 'Esta conexão não pode ser testada.',
  'cmsBackend.content.unreadable': 'Não foi possível ler a coleção de conteúdo.',
  'cmsBackend.data.parseFailed': 'Não foi possível analisar {file} — {detail}',
  'cmsBackend.data.readFailed': 'Não foi possível ler {file} — {detail}',
  'cmsBackend.data.tooLarge': '{file} é grande demais para editar aqui.',
  'cmsBackend.data.unreadableFormat': 'O Stacki ainda não consegue ler arquivos de dados {extension}.',
  'cmsBackend.entries.customLoader':
    '{collection} é construída por um loader deste projeto, não armazenada em um arquivo. Suas entradas são refeitas do zero a cada sincronização, então tudo o que for escrito aqui seria sobrescrito.', // review
  'cmsBackend.entries.idsGenerated':
    '{collection} gera os ids no loader, a partir dos campos de cada entrada. Os ids mostrados são os caminhos dos arquivos, que não são o que outras coleções referenciam.', // review
  'cmsBackend.entries.parserNote':
    '{collection} é analisada por uma função da configuração de conteúdo antes de o Astro vê-la. Os campos que não estão no arquivo foram criados por esse analisador: são exibidos, mas editar um aqui não teria para onde ir.', // review
  'cmsBackend.entry.generated': '{collection} gera os ids no loader, então o id não muda ao renomear um arquivo.', // review
  'cmsBackend.entry.noId': 'Nada em {file} diz qual é o id desta entrada.',
  'cmsBackend.entry.parsed': '{collection} é analisada por uma função da configuração de conteúdo, então os ids não estão no arquivo.', // review
  'cmsBackend.fieldName.empty': 'Dê um nome ao campo.',
  'cmsBackend.fieldName.invalid': 'O nome de um campo começa com uma letra e contém letras, dígitos, - e _.',
  'cmsBackend.fieldName.tooLong': { one: 'O nome de um campo tem no máximo {count} caractere.', other: 'O nome de um campo tem no máximo {count} caracteres.' },
  'cmsBackend.media.bodyNotBytes': 'O host enviou um corpo que não são bytes.',
  'cmsBackend.media.bodyTooLarge': 'O host enviou mais de {size} MB.',
  'cmsBackend.media.bunnyNoZone': 'Esta conta do Bunny não tem nenhuma storage zone chamada {name}.',
  'cmsBackend.media.bunnyNotList': 'O Bunny Storage enviou uma listagem que não é uma lista.',
  'cmsBackend.media.bunnyRefusedKey':
    'O Bunny recusou esta chave de API. Use a chave de API da conta (Account settings → API key), não a senha de uma storage zone.',
  'cmsBackend.media.bunnyUnreadable': 'O Bunny Storage enviou uma listagem ilegível.',
  'cmsBackend.media.cloudflareInactive': 'Este token da Cloudflare não está ativo. Crie um novo e cole-o de novo.',
  'cmsBackend.media.cloudflareNoToken': 'A Cloudflare não disse de qual token se trata.',
  'cmsBackend.media.cloudflareRefused': 'A Cloudflare recusou a solicitação.{detail}',
  'cmsBackend.media.fileGone': 'Esse arquivo não está mais lá.',
  'cmsBackend.media.fileTooLarge': '{name} é maior que {size} MB.',
  'cmsBackend.media.missingInFolder': '{name} não está mais nesta pasta. Atualize e tente de novo.',
  'cmsBackend.media.nameExists': 'Já existe algo com esse nome.',
  'cmsBackend.media.nestedTooDeep': 'Esta pasta está aninhada demais para alterar aqui.',
  'cmsBackend.media.status.limited': 'O host está limitando as solicitações. Tente de novo em instantes.{detail}',
  'cmsBackend.media.status.notFound': 'O host não tem esse bucket, zona ou arquivo.{detail}',
  'cmsBackend.media.status.refused': 'O host recusou a solicitação ({status}).{detail}',
  'cmsBackend.media.status.refusedKeys': 'O host recusou as chaves. Confira-as e se elas podem ler e gravar neste bucket.{detail}', // review
  'cmsBackend.media.status.server': 'O host teve um problema ({status}). Tente de novo em instantes.{detail}',
  'cmsBackend.media.tooManyFiles': 'Esta pasta tem mais de {count} arquivos; altere-a no painel do próprio host.',
  'cmsBackend.media.tooManyFilesBunny': 'Esta pasta tem mais de {count} arquivos; altere-a no painel do Bunny.',
  'cmsBackend.media.unreachable': 'Não foi possível acessar {host}: {reason}',
  'cmsBackend.network.failed': 'A solicitação ao CMS falhou.',
  'cmsBackend.payload.noDrafts': '{collection} não tem rascunhos para publicar ou descartar.',
  'cmsBackend.payload.noUpload': 'O Payload não tem nenhuma coleção de uploads visível para esta conta.',
  'cmsBackend.payload.notOrdered': 'As coleções do Payload não são ordenadas.',
  'cmsBackend.sample.answered': 'Esse endereço respondeu {status}.',
  'cmsBackend.sample.answeredWith': 'Esse endereço respondeu {status}: {detail}',
  'cmsBackend.sample.notFound': 'Nada foi encontrado nesse endereço (404).',
  'cmsBackend.sample.refused': 'Esse endereço recusou a solicitação ({status}). Verifique o cabeçalho e o valor dele.',
  'cmsBackend.sample.tooLarge': 'Essa resposta passa de {size} MB, grande demais para amostrar.',
  'cmsBackend.sanity.answered': 'O Sanity respondeu {status}.',
  'cmsBackend.sanity.noKeyRole':
    'Seu papel neste projeto do Sanity não pode criar chaves de API (Administrador ou Desenvolvedor podem). Peça uma a um administrador e cole-a com a opção de chave ao lado do botão de login.', // review
  'cmsBackend.sanity.signInFailed': 'Falha ao entrar no Sanity.',
  'cmsBackend.sanity.signInGone': 'Este login do Sanity não está mais em andamento.',
  'cmsBackend.sanity.signInTimedOut': 'O login do Sanity expirou.',
  'cmsBackend.sanity.someone': 'Alguém',
  'cmsBackend.schema.collectionExists': 'Já existe uma coleção chamada {name}.',
  'cmsBackend.schema.fieldExists': 'Já existe um campo chamado {name}.',
  'cmsBackend.schema.fieldsChanged': 'Os campos mudaram desde que foram listados. Reabra as configurações.',
  'cmsBackend.schema.imageByHand': 'Adicione `image` manualmente à função do esquema e depois adicione o campo.',
  'cmsBackend.schema.noField': 'Não há nenhum campo {name}.',
  'cmsBackend.schema.noImageSchema': 'Esta coleção não tem esquema para receber um campo de imagem.',
  'cmsBackend.schema.noObject': '{collection} não tem na configuração nenhum esquema z.object({{ … }}) para editar.',
  'cmsBackend.schema.notCollection': '{name} não é uma coleção da configuração de conteúdo.',
  'cmsBackend.schema.tooComplex': '{name} está escrito como método ou como uma cadeia muito longa; edite na configuração.',
  'cmsBackend.slug.empty': 'Um slug precisa de pelo menos uma letra ou um número',
  'cmsBackend.slug.saved': 'Salvo como “{slug}”',
  'cmsBackend.slug.taken': 'Outro item já usa este slug',
  'cmsBackend.slug.tooLong': { one: 'No máximo {count} caractere', other: 'No máximo {count} caracteres' },
} as const satisfies CatalogOf<MessageKey>;
