// French `roles` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/roles';

export const messages = {
  'roles.group.panels': 'Panneaux',
  'roles.group.pages': 'Pages', // same
  'roles.group.components': 'Composants',
  'roles.group.codeAndPublishing': 'Code et publication',
  'roles.group.apps': 'Apps', // same
  'roles.group.settings': 'Réglages',
  'roles.feature.panelPages': 'Pages', // same
  'roles.feature.panelNavigator': 'Navigateur', // same
  'roles.feature.panelProperties': 'Propriétés du composant',
  'roles.feature.panelComponents': 'Composants',
  'roles.feature.panelAssets': 'Ressources',
  'roles.feature.panelCms': 'CMS', // same
  'roles.feature.panelVariables': 'Variables', // same
  'roles.feature.panelSelectors': 'Sélecteurs de style',
  'roles.feature.panelCode': 'Code', // same
  'roles.feature.panelHistory': 'Git', // same
  'roles.feature.panelApps': 'Apps', // same
  'roles.feature.panelAi': 'Chat IA',
  'roles.feature.panelInstructions': 'Instructions', // same
  'roles.feature.panelAudits': 'Audits', // same
  'roles.feature.panelProjectSettings': 'Réglages du projet (secrets)',
  'roles.feature.panelStyle': 'Panneau de style',
  'roles.feature.panelSettings': 'Panneau des réglages',
  'roles.feature.pageCreate': 'Créer des pages',
  'roles.feature.pageDelete': 'Supprimer des pages',
  'roles.feature.pageRename': 'Renommer et déplacer des pages',
  'roles.feature.pageLayout': 'Modifier le layout et ce qui est hors de lui',
  'roles.feature.componentCreate': 'Créer des composants',
  'roles.feature.componentEdit': 'Modifier la source du composant',
  'roles.feature.codeEdit': 'Modifier le code',
  'roles.feature.instructionsEdit': 'Modifier les instructions',
  'roles.feature.publish': 'Publier',
  'roles.feature.marketplaceView': 'Voir la marketplace',
  'roles.feature.marketplaceInstall': 'Installer depuis la marketplace',
  'roles.feature.marketplacePublish': 'Publier sur la marketplace',
  'roles.feature.appsShare': 'Partager des apps sur GitHub',
  'roles.feature.settingsEditor': 'Réglages de l’éditeur',
  'roles.feature.settingsFolders': 'Dossiers',
  'roles.feature.settingsCms': 'Connexions CMS et médias',
  'roles.feature.settingsStudio': 'Stacki Studio', // same
  'roles.feature.settingsInstructions': 'Instructions masquées',
  'roles.feature.settingsAudits': 'Vérifications d’audit',
  'roles.delete.noMembers': 'Il n’a aucun membre.',
  'roles.delete.members': {
    one: 'Son membre ({members}) devient une personne sans rôle.',
    other: 'Ses {count} membres ({members}) deviennent des personnes sans rôle.',
  },
  'roles.delete.defaultRole': 'C’est le rôle des personnes sans rôle : celui-ci devient Admin.',
  'roles.delete.viewing': 'Vous l’utilisez en aperçu : l’aperçu revient à Admin.',
  'roles.copy.name': '{name} copie',
  'roles.copy.numbered': '{name} copie {number}',
  'roles.error.rolesMax': { one: 'Un projet compte au plus {count} rôle', other: 'Un projet compte au plus {count} rôles' },
  'roles.error.nameEmpty': 'Un rôle a besoin d’un nom',
  'roles.error.nameLong': 'Le nom d’un rôle compte au plus {max} caractères',
  'roles.error.nameTaken': 'Il existe déjà un rôle nommé {name}',
  'roles.error.memberListed': '{login} est déjà dans {role}',
  'roles.error.membersMax': { one: 'Un rôle compte au plus {count} membre', other: 'Un rôle compte au plus {count} membres' },
  'roles.error.lastAdmin': 'Au moins une personne doit être admin',
  'roles.error.appsMax': {
    one: 'Un rôle conserve les permissions d’au plus {count} app. Retirez dans roles.json les réglages des apps qui ne sont plus installées.',
    other: 'Un rôle conserve les permissions d’au plus {count} apps. Retirez dans roles.json les réglages des apps qui ne sont plus installées.',
  },
  'roles.error.permissionsMax': {
    one: 'Un rôle conserve au plus {count} permission pour une app',
    other: 'Un rôle conserve au plus {count} permissions pour une app',
  },
  'roles.error.pinsMax': { one: 'Un rôle épingle au plus {count} app', other: 'Un rôle épingle au plus {count} apps' },
  'roles.error.lockout': 'Cela ferait de vous ({login}) {role} et retirerait votre accès admin. Restez admin.',
  'roles.error.loginLength': 'Un nom d’utilisateur GitHub compte de 1 à {max} caractères',
  'roles.error.loginInvalid': '« {login} » n’est pas un nom d’utilisateur GitHub',
  'roles.menu.yours': 'Votre rôle',
  'roles.menu.viewAs': 'Afficher en tant que',
  'roles.menu.waitForSave': 'Attendez que vos modifications soient enregistrées',
} as const satisfies CatalogOf<MessageKey>;
