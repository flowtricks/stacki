// Brazilian Portuguese `roles` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/roles';

export const messages = {
  'roles.group.panels': 'Painéis',
  'roles.group.pages': 'Páginas',
  'roles.group.components': 'Componentes',
  'roles.group.codeAndPublishing': 'Código e publicação',
  'roles.group.apps': 'Apps', // same
  'roles.group.settings': 'Configurações',
  'roles.feature.panelPages': 'Páginas',
  'roles.feature.panelNavigator': 'Navegador', // same
  'roles.feature.panelProperties': 'Propriedades do componente',
  'roles.feature.panelComponents': 'Componentes',
  'roles.feature.panelAssets': 'Recursos',
  'roles.feature.panelCms': 'CMS', // same
  'roles.feature.panelVariables': 'Variáveis',
  'roles.feature.panelSelectors': 'Seletores de estilo',
  'roles.feature.panelCode': 'Código',
  'roles.feature.panelHistory': 'Git', // same
  'roles.feature.panelApps': 'Apps', // same
  'roles.feature.panelAi': 'Chat de IA',
  'roles.feature.panelInstructions': 'Instruções',
  'roles.feature.panelAudits': 'Auditorias',
  'roles.feature.panelProjectSettings': 'Configurações do projeto (segredos)',
  'roles.feature.panelStyle': 'Painel de estilo',
  'roles.feature.panelSettings': 'Painel de configurações',
  'roles.feature.pageCreate': 'Criar páginas',
  'roles.feature.pageDelete': 'Excluir páginas',
  'roles.feature.pageRename': 'Renomear e mover páginas',
  'roles.feature.pageLayout': 'Editar o layout e o que está fora dele',
  'roles.feature.componentCreate': 'Criar componentes',
  'roles.feature.componentEdit': 'Editar o código-fonte do componente',
  'roles.feature.codeEdit': 'Editar código',
  'roles.feature.instructionsEdit': 'Editar instruções',
  'roles.feature.publish': 'Publicar',
  'roles.feature.marketplaceView': 'Ver o marketplace',
  'roles.feature.marketplaceInstall': 'Instalar do marketplace',
  'roles.feature.marketplacePublish': 'Publicar no marketplace',
  'roles.feature.appsShare': 'Compartilhar apps no GitHub',
  'roles.feature.settingsEditor': 'Configurações do editor',
  'roles.feature.settingsFolders': 'Pastas',
  'roles.feature.settingsCms': 'Conexões de CMS e mídia',
  'roles.feature.settingsStudio': 'Stacki Studio', // same
  'roles.feature.settingsInstructions': 'Instruções ocultas',
  'roles.feature.settingsAudits': 'Verificações de auditoria',
  'roles.delete.noMembers': 'Ele não tem membros.',
  'roles.delete.members': {
    one: 'Seu membro ({members}) passa a ser uma pessoa sem papel.',
    other: 'Seus {count} membros ({members}) passam a ser pessoas sem papel.',
  },
  'roles.delete.defaultRole': 'É o papel das pessoas sem papel, então isso passa a ser Admin.',
  'roles.delete.viewing': 'Você está vendo como ele, então a visualização volta para Admin.',
  'roles.copy.name': '{name} cópia',
  'roles.copy.numbered': '{name} cópia {number}',
  'roles.error.rolesMax': { one: 'Um projeto tem no máximo {count} papel', other: 'Um projeto tem no máximo {count} papéis' },
  'roles.error.nameEmpty': 'Um papel precisa de um nome',
  'roles.error.nameLong': 'O nome de um papel tem no máximo {max} caracteres',
  'roles.error.nameTaken': 'Já existe um papel chamado {name}',
  'roles.error.memberListed': '{login} já está em {role}',
  'roles.error.membersMax': { one: 'Um papel tem no máximo {count} membro', other: 'Um papel tem no máximo {count} membros' },
  'roles.error.lastAdmin': 'Pelo menos uma pessoa deve ser admin',
  'roles.error.appsMax': {
    one: 'Um papel guarda permissões de no máximo {count} app. Remova em roles.json as configurações de apps que não estão mais instalados.',
    other: 'Um papel guarda permissões de no máximo {count} apps. Remova em roles.json as configurações de apps que não estão mais instalados.',
  },
  'roles.error.permissionsMax': {
    one: 'Um papel guarda no máximo {count} permissão para um app',
    other: 'Um papel guarda no máximo {count} permissões para um app',
  },
  'roles.error.pinsMax': { one: 'Um papel fixa no máximo {count} app', other: 'Um papel fixa no máximo {count} apps' },
  'roles.error.lockout': 'Isso faria de você ({login}) {role} e removeria seu acesso de admin. Continue sendo admin.',
  'roles.error.loginLength': 'Um usuário do GitHub tem de 1 a {max} caracteres',
  'roles.error.loginInvalid': '“{login}” não é um usuário do GitHub',
  'roles.menu.yours': 'Seu papel',
  'roles.menu.viewAs': 'Ver como',
  'roles.menu.waitForSave': 'Aguarde suas edições terminarem de ser salvas',
} as const satisfies CatalogOf<MessageKey>;
