// German `cmsBackend` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/cmsBackend';

export const messages = {
  'cmsBackend.body.description': 'Das Markdown des Eintrags, unter dem Frontmatter.',
  'cmsBackend.body.title': 'Inhalt',
  'cmsBackend.config.collectionExists': 'Eine Sammlung namens „{name}“ gibt es schon.',
  'cmsBackend.config.collectionsNotClosed': 'Der collections-Export der Inhaltskonfiguration ist nicht geschlossen.',
  'cmsBackend.config.nameUsed': '„{name}“ wird in der Inhaltskonfiguration schon verwendet.',
  'cmsBackend.config.noCollections': 'Stacki hat `export const collections = {{ … }}` in der Inhaltskonfiguration nicht gefunden.',
  'cmsBackend.config.notListed': '{collection} steht nicht in den Sammlungen der Inhaltskonfiguration.',
  'cmsBackend.config.tooLarge': 'Die Inhaltskonfiguration ist zu groß, um sie hier zu bearbeiten.',
  'cmsBackend.connection.cannotTest': 'Diese Verbindung lässt sich nicht testen.',
  'cmsBackend.content.unreadable': 'Die Inhaltssammlung konnte nicht gelesen werden.',
  'cmsBackend.data.parseFailed': '{file} konnte nicht gelesen werden — {detail}',
  'cmsBackend.data.readFailed': '{file} konnte nicht gelesen werden — {detail}',
  'cmsBackend.data.tooLarge': '{file} ist zu groß, um hier bearbeitet zu werden.',
  'cmsBackend.data.unreadableFormat': 'Stacki kann {extension}-Datendateien noch nicht lesen.',
  'cmsBackend.entries.customLoader':
    '{collection} wird von einem Loader in diesem Projekt erzeugt und nicht in einer Datei gespeichert. Die Einträge werden bei jeder Synchronisierung neu aufgebaut, daher würde alles, was hier geschrieben wird, überschrieben.', // review
  'cmsBackend.entries.idsGenerated':
    '{collection} erzeugt seine IDs im Loader aus den Feldern des Eintrags. Die angezeigten IDs sind die Dateipfade, auf die andere Sammlungen nicht verweisen.', // review
  'cmsBackend.entries.parserNote':
    '{collection} wird von einer Funktion in der Inhaltskonfiguration verarbeitet, bevor Astro sie sieht. Felder, die nicht in der Datei stehen, stammen von diesem Parser: Sie werden angezeigt, aber eine Änderung hier könnte nirgends gespeichert werden.', // review
  'cmsBackend.entry.generated': '{collection} erzeugt seine IDs im Loader, daher lässt sich die ID nicht durch Umbenennen einer Datei ändern.', // review
  'cmsBackend.entry.noId': 'In {file} steht nichts darüber, wie die ID dieses Eintrags lautet.',
  'cmsBackend.entry.parsed': '{collection} wird von einer Funktion in der Inhaltskonfiguration gelesen, daher stehen die IDs nicht in der Datei.', // review
  'cmsBackend.fieldName.empty': 'Gib dem Feld einen Namen.',
  'cmsBackend.fieldName.invalid': 'Ein Feldname beginnt mit einem Buchstaben und enthält Buchstaben, Ziffern, - und _.',
  'cmsBackend.fieldName.tooLong': { one: 'Ein Feldname hat höchstens {count} Zeichen.', other: 'Ein Feldname hat höchstens {count} Zeichen.' },
  'cmsBackend.media.bodyNotBytes': 'Der Host hat einen Inhalt gesendet, der keine Bytes sind.',
  'cmsBackend.media.bodyTooLarge': 'Der Host hat mehr als {size} MB gesendet.',
  'cmsBackend.media.bunnyNoZone': 'Dieses Bunny-Konto hat keine Storage Zone namens {name}.',
  'cmsBackend.media.bunnyNotList': 'Bunny Storage hat eine Auflistung gesendet, die keine Liste ist.',
  'cmsBackend.media.bunnyRefusedKey':
    'Bunny hat diesen API-Schlüssel abgelehnt. Nutze den API-Schlüssel des Kontos (Account settings → API key), nicht das Passwort einer Storage Zone.',
  'cmsBackend.media.bunnyUnreadable': 'Bunny Storage hat eine unlesbare Auflistung gesendet.',
  'cmsBackend.media.cloudflareInactive': 'Dieses Cloudflare-Token ist nicht aktiv. Erstelle ein neues und füge es erneut ein.',
  'cmsBackend.media.cloudflareNoToken': 'Cloudflare hat nicht angegeben, um welches Token es sich handelt.',
  'cmsBackend.media.cloudflareRefused': 'Cloudflare hat die Anfrage abgelehnt.{detail}',
  'cmsBackend.media.fileGone': 'Diese Datei ist nicht mehr vorhanden.',
  'cmsBackend.media.fileTooLarge': '{name} ist größer als {size} MB.',
  'cmsBackend.media.missingInFolder': '{name} ist nicht mehr in diesem Ordner. Aktualisiere und versuche es erneut.',
  'cmsBackend.media.nameExists': 'Etwas mit diesem Namen gibt es schon.',
  'cmsBackend.media.nestedTooDeep': 'Dieser Ordner ist zu tief verschachtelt, um ihn hier zu ändern.',
  'cmsBackend.media.status.limited': 'Der Host begrenzt die Anfragen. Versuche es gleich noch einmal.{detail}',
  'cmsBackend.media.status.notFound': 'Der Host kennt diesen Bucket, diese Zone oder diese Datei nicht.{detail}',
  'cmsBackend.media.status.refused': 'Der Host hat die Anfrage abgelehnt ({status}).{detail}',
  'cmsBackend.media.status.refusedKeys': 'Der Host hat die Schlüssel abgelehnt. Prüfe sie und ob sie diesen Bucket lesen und beschreiben dürfen.{detail}', // review
  'cmsBackend.media.status.server': 'Beim Host ist ein Problem aufgetreten ({status}). Versuche es gleich noch einmal.{detail}',
  'cmsBackend.media.tooManyFiles': 'Dieser Ordner enthält mehr als {count} Dateien; ändere ihn im Dashboard des Hosts.',
  'cmsBackend.media.tooManyFilesBunny': 'Dieser Ordner enthält mehr als {count} Dateien; ändere ihn im Dashboard von Bunny.',
  'cmsBackend.media.unreachable': '{host} ist nicht erreichbar: {reason}',
  'cmsBackend.network.failed': 'Die Anfrage an das CMS ist fehlgeschlagen.',
  'cmsBackend.payload.noDrafts': '{collection} hat keine Entwürfe zum Veröffentlichen oder Verwerfen.',
  'cmsBackend.payload.noUpload': 'Payload hat keine Upload-Sammlung, die dieses Konto sehen kann.',
  'cmsBackend.payload.notOrdered': 'Payload-Sammlungen sind nicht geordnet.',
  'cmsBackend.sample.answered': 'Diese Adresse antwortete mit {status}.',
  'cmsBackend.sample.answeredWith': 'Diese Adresse antwortete mit {status}: {detail}',
  'cmsBackend.sample.notFound': 'Unter dieser Adresse wurde nichts gefunden (404).',
  'cmsBackend.sample.refused': 'Diese Adresse hat die Anfrage abgelehnt ({status}). Prüfe den Header und seinen Wert.',
  'cmsBackend.sample.tooLarge': 'Diese Antwort ist größer als {size} MB und damit zu groß für eine Stichprobe.',
  'cmsBackend.sanity.answered': 'Sanity antwortete mit {status}.',
  'cmsBackend.sanity.noKeyRole':
    'Deine Rolle in diesem Sanity-Projekt darf keine API-Schlüssel erstellen (Administrator oder Developer dürfen es). Bitte einen Admin um einen und füge ihn über die Schlüssel-Option neben der Anmelde-Schaltfläche ein.', // review
  'cmsBackend.sanity.signInFailed': 'Die Anmeldung bei Sanity ist fehlgeschlagen.',
  'cmsBackend.sanity.signInGone': 'Diese Sanity-Anmeldung läuft nicht mehr.',
  'cmsBackend.sanity.signInTimedOut': 'Die Sanity-Anmeldung hat zu lange gedauert.',
  'cmsBackend.sanity.someone': 'Jemand',
  'cmsBackend.schema.collectionExists': 'Eine Sammlung namens {name} gibt es schon.',
  'cmsBackend.schema.fieldExists': 'Ein Feld namens {name} gibt es schon.',
  'cmsBackend.schema.fieldsChanged': 'Die Felder haben sich seit der Anzeige geändert. Öffne die Einstellungen neu.',
  'cmsBackend.schema.imageByHand': 'Füge `image` von Hand zur Funktion des Schemas hinzu und ergänze dann das Feld.',
  'cmsBackend.schema.noField': 'Es gibt kein Feld {name}.',
  'cmsBackend.schema.noImageSchema': 'Diese Sammlung hat kein Schema, dem ein Bildfeld hinzugefügt werden könnte.',
  'cmsBackend.schema.noObject': '{collection} hat in der Konfiguration kein z.object({{ … }})-Schema zum Bearbeiten.',
  'cmsBackend.schema.notCollection': '{name} ist keine Sammlung der Inhaltskonfiguration.',
  'cmsBackend.schema.tooComplex': '{name} ist als Methode oder sehr lange Kette geschrieben; bearbeite es in der Konfiguration.',
  'cmsBackend.slug.empty': 'Ein Slug braucht mindestens einen Buchstaben oder eine Ziffer',
  'cmsBackend.slug.saved': 'Gespeichert als „{slug}“',
  'cmsBackend.slug.taken': 'Ein anderes Element verwendet diesen Slug schon',
  'cmsBackend.slug.tooLong': { one: 'Höchstens {count} Zeichen', other: 'Höchstens {count} Zeichen' },
} as const satisfies CatalogOf<MessageKey>;
