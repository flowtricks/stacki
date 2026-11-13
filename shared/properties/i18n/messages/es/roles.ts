// Spanish `roles` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/roles';

export const messages = {
  'roles.group.panels': 'Paneles',
  'roles.group.pages': 'Páginas',
  'roles.group.components': 'Componentes',
  'roles.group.codeAndPublishing': 'Código y publicación',
  'roles.group.apps': 'Apps', // same
  'roles.group.settings': 'Ajustes',
  'roles.feature.panelPages': 'Páginas',
  'roles.feature.panelNavigator': 'Navegador', // same
  'roles.feature.panelProperties': 'Propiedades del componente',
  'roles.feature.panelComponents': 'Componentes',
  'roles.feature.panelAssets': 'Recursos',
  'roles.feature.panelCms': 'CMS', // same
  'roles.feature.panelVariables': 'Variables', // same
  'roles.feature.panelSelectors': 'Selectores de estilo',
  'roles.feature.panelCode': 'Código',
  'roles.feature.panelHistory': 'Git', // same
  'roles.feature.panelApps': 'Apps', // same
  'roles.feature.panelAi': 'Chat de IA',
  'roles.feature.panelInstructions': 'Instrucciones',
  'roles.feature.panelAudits': 'Auditorías',
  'roles.feature.panelProjectSettings': 'Ajustes del proyecto (secretos)',
  'roles.feature.panelStyle': 'Panel de estilo',
  'roles.feature.panelSettings': 'Panel de ajustes',
  'roles.feature.pageCreate': 'Crear páginas',
  'roles.feature.pageDelete': 'Eliminar páginas',
  'roles.feature.pageRename': 'Renombrar y mover páginas',
  'roles.feature.pageLayout': 'Editar el layout y lo que está fuera',
  'roles.feature.componentCreate': 'Crear componentes',
  'roles.feature.componentEdit': 'Editar el código del componente',
  'roles.feature.codeEdit': 'Editar código',
  'roles.feature.instructionsEdit': 'Editar instrucciones',
  'roles.feature.publish': 'Publicar',
  'roles.feature.marketplaceView': 'Ver el marketplace',
  'roles.feature.marketplaceInstall': 'Instalar desde el marketplace',
  'roles.feature.marketplacePublish': 'Publicar en el marketplace',
  'roles.feature.appsShare': 'Compartir apps en GitHub',
  'roles.feature.settingsEditor': 'Ajustes del editor',
  'roles.feature.settingsFolders': 'Carpetas',
  'roles.feature.settingsCms': 'Conexiones de CMS y medios',
  'roles.feature.settingsStudio': 'Stacki Studio', // same
  'roles.feature.settingsInstructions': 'Instrucciones ocultas',
  'roles.feature.settingsAudits': 'Comprobaciones de auditoría',
  'roles.delete.noMembers': 'No tiene miembros.',
  'roles.delete.members': {
    one: 'Su miembro ({members}) pasa a ser una persona sin rol.',
    other: 'Sus {count} miembros ({members}) pasan a ser personas sin rol.',
  },
  'roles.delete.defaultRole': 'Es el rol de las personas sin rol, así que pasa a ser Admin.',
  'roles.delete.viewing': 'Lo estás viendo como este rol, así que la vista vuelve a Admin.',
  'roles.copy.name': '{name} copia',
  'roles.copy.numbered': '{name} copia {number}',
  'roles.error.rolesMax': { one: 'Un proyecto tiene como máximo {count} rol', other: 'Un proyecto tiene como máximo {count} roles' },
  'roles.error.nameEmpty': 'Un rol necesita un nombre',
  'roles.error.nameLong': 'El nombre de un rol tiene como máximo {max} caracteres',
  'roles.error.nameTaken': 'Ya existe un rol llamado {name}',
  'roles.error.memberListed': '{login} ya está en {role}',
  'roles.error.membersMax': { one: 'Un rol tiene como máximo {count} miembro', other: 'Un rol tiene como máximo {count} miembros' },
  'roles.error.lastAdmin': 'Al menos una persona debe ser admin',
  'roles.error.appsMax': {
    one: 'Un rol guarda permisos de como máximo {count} app. Quita en roles.json los ajustes de apps que ya no están instaladas.',
    other: 'Un rol guarda permisos de como máximo {count} apps. Quita en roles.json los ajustes de apps que ya no están instaladas.',
  },
  'roles.error.permissionsMax': {
    one: 'Un rol guarda como máximo {count} permiso para una app',
    other: 'Un rol guarda como máximo {count} permisos para una app',
  },
  'roles.error.pinsMax': { one: 'Un rol fija como máximo {count} app', other: 'Un rol fija como máximo {count} apps' },
  'roles.error.lockout': 'Esto te convertiría ({login}) en {role} y quitaría tu acceso de admin. Sigue siendo admin.',
  'roles.error.loginLength': 'Un usuario de GitHub tiene de 1 a {max} caracteres',
  'roles.error.loginInvalid': '«{login}» no es un usuario de GitHub',
  'roles.menu.yours': 'Tu rol',
  'roles.menu.viewAs': 'Ver como',
  'roles.menu.waitForSave': 'Espera a que terminen de guardarse tus cambios',
} as const satisfies CatalogOf<MessageKey>;
