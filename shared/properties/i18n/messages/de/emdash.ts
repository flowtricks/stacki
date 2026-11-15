// German `emdash` strings (EmDash support). Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/emdash';

export const messages = {
  'emdash.absent.create': 'Starte eine neue Website mit der EmDash-Vorlage:',
  'emdash.absent.hint':
    'Stacki erkennt EmDash am Projekt selbst: dem Paket emdash, seiner Astro-Integration und der Live-Collection _emdash. Füge sie hinzu und öffne die Einstellungen erneut.',
  'emdash.absent.title': 'EmDash ist in diesem Projekt nicht eingerichtet',
  'emdash.binding.boolean': 'Ja/Nein',
  'emdash.binding.data': 'Daten',
  'emdash.binding.date': 'Datum',
  'emdash.binding.file': 'Datei',
  'emdash.binding.image': 'Bild',
  'emdash.binding.link': 'Link', // same
  'emdash.binding.list': 'Liste',
  'emdash.binding.number': 'Zahl',
  'emdash.binding.reference': 'Referenz',
  'emdash.binding.richText': 'Formatierter Text',
  'emdash.binding.text': 'Text', // same
  'emdash.field.required': 'Pflicht',
  'emdash.field.unsupported': 'Unbekannter Typ',
  'emdash.guide.analyze': 'Prüfe, was importiert wird (die lokale Website muss leer sein):',
  'emdash.guide.export': 'Exportiere die Website des Kunden. Das liest nur daraus:',
  'emdash.guide.import': 'Importiere es in deine lokale Kopie:',
  'emdash.guide.login': 'Melde dich auf der EmDash-Website des Kunden an:',
  'emdash.guide.safe':
    'Die lokale Datenbank und die Uploads bleiben auf diesem Computer und werden nie veröffentlicht. Nur der Kunde ändert seine Inhalte, in seinem eigenen EmDash-Admin.',
  'emdash.guide.title': 'Vorschau mit echten Kundeninhalten',
  'emdash.hint.definedInEmDash':
    'Inhaltstypen und Felder werden nur in EmDash festgelegt. Ändere sie in dessen Admin; Stacki liest sie und bearbeitet sie nie.',
  'emdash.output.server': 'bei Anfrage (Server)',
  'emdash.output.static': 'beim Build (statisch)',
  'emdash.output.unknown': 'nicht in der Konfiguration gesetzt',
  'emdash.problem.databaseTracked': 'Die lokale Datenbank steht nicht in .gitignore. Trage sie ein, damit ein Deploy nie deine lokalen Inhalte mitnimmt.',
  'emdash.problem.databaseUnreadable':
    'Die lokale Datenbank konnte nicht gelesen werden. Stoppe den Dev-Server, falls er gerade migriert, und öffne die Einstellungen erneut.',
  'emdash.problem.noDatabase': 'Noch keine lokale Datenbank. Starte den Dev-Server einmal und schließe die Einrichtung unter /_emdash/admin ab.',
  'emdash.problem.noIntegration': 'Füge die Integration emdash() aus emdash/astro zu astro.config hinzu.',
  'emdash.problem.noLiveCollection': 'Registriere die Live-Collection _emdash in src/live.config.ts mit emdashLoader().',
  'emdash.problem.noSchema': 'Noch keine Inhaltstypen. Lege sie im EmDash-Admin an oder führe emdash types aus, um eine Schemadatei zu speichern.',
  'emdash.problem.notInstalled': 'Installiere das Paket emdash (npm install emdash).',
  'emdash.problem.schemaUnreadable': 'Die Schemadatei konnte nicht gelesen werden. Führe emdash types erneut aus.',
  'emdash.problem.staticOutput': 'EmDash liest Inhalte, wenn eine Seite angefragt wird. Setze output auf server und füge in astro.config einen Adapter hinzu.',
  'emdash.problem.uploadsTracked': 'Der Upload-Ordner steht nicht in .gitignore. Trage ihn ein, damit Medien nie mit deinem Code mitgehen.',
  'emdash.schema.database': 'Aus der lokalen EmDash-Datenbank gelesen',
  'emdash.schema.schemaJson': 'Aus .emdash/schema.json gelesen',
  'emdash.schema.seed': 'Aus der Seed-Datei gelesen',
  'emdash.status.collections': 'Inhaltstypen',
  'emdash.status.database': 'Lokale Datenbank',
  'emdash.status.output': 'Seiten werden gerendert',
  'emdash.template.collection': 'Inhaltstyp',
  'emdash.template.create': 'Vorlage erstellen',
  'emdash.template.empty': 'Keine Inhaltstypen gefunden. Lege sie zuerst in EmDash an.',
  'emdash.template.layout': 'Layout', // same
  'emdash.template.menu': 'EmDash-Seitenvorlage',
  'emdash.template.noLayout': 'Kein Layout',
  'emdash.template.noSuchCollection': 'Das EmDash-Projekt hat keinen Inhaltstyp namens „{collection}“.',
  'emdash.template.notEmDash': 'Dieses Projekt verwendet EmDash noch nicht.',
  'emdash.template.route': 'Seitenadresse',
  'emdash.template.routeHint': 'Jeder Eintrag in EmDash bekommt unter dieser Adresse eine eigene Seite, die immer den aktuellen Inhalt zeigt.',
  'emdash.template.title': 'Neue EmDash-Seitenvorlage',
  'emdash.title': 'EmDash', // same
  'emdash.unavailable': 'EmDash wird aus dem Projektordner gelesen und ist deshalb vorerst nur in Stacki Desktop verfügbar.',
} as const satisfies CatalogOf<MessageKey>;
