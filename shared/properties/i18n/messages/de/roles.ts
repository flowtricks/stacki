// German `roles` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/roles';

export const messages = {
  'roles.group.panels': 'Bereiche',
  'roles.group.pages': 'Seiten',
  'roles.group.components': 'Komponenten',
  'roles.group.codeAndPublishing': 'Code und Veröffentlichung',
  'roles.group.apps': 'Apps', // same
  'roles.group.settings': 'Einstellungen',
  'roles.feature.panelPages': 'Seiten',
  'roles.feature.panelNavigator': 'Navigator', // same
  'roles.feature.panelProperties': 'Komponenteneigenschaften',
  'roles.feature.panelComponents': 'Komponenten',
  'roles.feature.panelAssets': 'Assets', // same
  'roles.feature.panelCms': 'CMS', // same
  'roles.feature.panelVariables': 'Variablen',
  'roles.feature.panelSelectors': 'Stil-Selektoren',
  'roles.feature.panelCode': 'Code', // same
  'roles.feature.panelHistory': 'Git', // same
  'roles.feature.panelApps': 'Apps', // same
  'roles.feature.panelAi': 'KI-Chat',
  'roles.feature.panelInstructions': 'Anweisungen',
  'roles.feature.panelAudits': 'Audits', // same
  'roles.feature.panelProjectSettings': 'Projekteinstellungen (Secrets)',
  'roles.feature.panelStyle': 'Stil-Bereich',
  'roles.feature.panelSettings': 'Einstellungs-Bereich',
  'roles.feature.pageCreate': 'Seiten erstellen',
  'roles.feature.pageDelete': 'Seiten löschen',
  'roles.feature.pageRename': 'Seiten umbenennen und verschieben',
  'roles.feature.pageLayout': 'Layout und alles außerhalb bearbeiten',
  'roles.feature.componentCreate': 'Komponenten erstellen',
  'roles.feature.componentEdit': 'Komponenten-Quelltext bearbeiten',
  'roles.feature.codeEdit': 'Code bearbeiten',
  'roles.feature.instructionsEdit': 'Anweisungen bearbeiten',
  'roles.feature.publish': 'Veröffentlichen',
  'roles.feature.marketplaceView': 'Marketplace ansehen',
  'roles.feature.marketplaceInstall': 'Aus dem Marketplace installieren',
  'roles.feature.marketplacePublish': 'Im Marketplace veröffentlichen',
  'roles.feature.appsShare': 'Apps auf GitHub teilen',
  'roles.feature.settingsEditor': 'Editor-Einstellungen',
  'roles.feature.settingsFolders': 'Ordner',
  'roles.feature.settingsCms': 'CMS- und Medienverbindungen',
  'roles.feature.settingsStudio': 'Stacki Studio', // same
  'roles.feature.settingsInstructions': 'Ausgeblendete Anweisungen',
  'roles.feature.settingsAudits': 'Audit-Prüfungen',
  'roles.delete.noMembers': 'Sie hat keine Mitglieder.',
  'roles.delete.members': {
    one: 'Ihr Mitglied ({members}) wird zu einer Person ohne Rolle.',
    other: 'Ihre {count} Mitglieder ({members}) werden zu Personen ohne Rolle.',
  },
  'roles.delete.defaultRole': 'Sie ist die Rolle für Personen ohne Rolle, daher wird das Admin.',
  'roles.delete.viewing': 'Du siehst Studio als diese Rolle; die Ansicht wechselt zurück zu Admin.',
  'roles.copy.name': '{name} Kopie',
  'roles.copy.numbered': '{name} Kopie {number}',
  'roles.error.rolesMax': { one: 'Ein Projekt hat höchstens {count} Rolle', other: 'Ein Projekt hat höchstens {count} Rollen' },
  'roles.error.nameEmpty': 'Eine Rolle braucht einen Namen',
  'roles.error.nameLong': 'Ein Rollenname hat höchstens {max} Zeichen',
  'roles.error.nameTaken': 'Es gibt bereits eine Rolle namens {name}',
  'roles.error.memberListed': '{login} ist schon in {role}',
  'roles.error.membersMax': { one: 'Eine Rolle hat höchstens {count} Mitglied', other: 'Eine Rolle hat höchstens {count} Mitglieder' },
  'roles.error.lastAdmin': 'Mindestens eine Person muss Admin sein',
  'roles.error.appsMax': {
    one: 'Eine Rolle speichert App-Berechtigungen für höchstens {count} App. Entferne in roles.json die Einstellungen für nicht mehr installierte Apps.',
    other: 'Eine Rolle speichert App-Berechtigungen für höchstens {count} Apps. Entferne in roles.json die Einstellungen für nicht mehr installierte Apps.',
  },
  'roles.error.permissionsMax': {
    one: 'Eine Rolle speichert höchstens {count} Berechtigung für eine App',
    other: 'Eine Rolle speichert höchstens {count} Berechtigungen für eine App',
  },
  'roles.error.pinsMax': { one: 'Eine Rolle pinnt höchstens {count} App', other: 'Eine Rolle pinnt höchstens {count} Apps' },
  'roles.error.lockout': 'Damit wärst du ({login}) {role} und hättest keinen Admin-Zugriff mehr. Bleib Admin.',
  'roles.error.loginLength': 'Ein GitHub-Benutzername hat 1 bis {max} Zeichen',
  'roles.error.loginInvalid': '„{login}“ ist kein GitHub-Benutzername',
  'roles.menu.yours': 'Deine Rolle',
  'roles.menu.viewAs': 'Ansehen als',
  'roles.menu.waitForSave': 'Warte, bis deine Änderungen gespeichert sind',
} as const satisfies CatalogOf<MessageKey>;
