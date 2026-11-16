// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/apps/settings.json`: the non-secret setting values of installed apps (kinds text and url), by app id then setting id.
// Secret settings are never in this file: the app seals them in the keychain or a vault outside the project, and the CLI never touches them.
import { APP_LIMITS, parseAppId } from '../../apps';
import { APP_SETTINGS_FILE as APP_SETTINGS_PATH, APP_SETTINGS_LIMITS, parseAppSettingsFileSource, serializeAppSettingsFile } from '../../appSettings';
import { field, literal, mapOf, text, type FileSchema } from '../stackiSchema';

const APP_ID = '^[a-z0-9][a-z0-9._-]*$';
const SETTING_ID = '^[a-z][a-z0-9_-]*$';

export const APP_SETTINGS_FILE: FileSchema = {
  id: 'appSettings',
  file: APP_SETTINGS_PATH,
  description: 'Non-secret app setting values shared with the project, by app id then setting id. Secret settings never live here.',
  requires: 'panel:apps',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    apps: field(
      mapOf(
        mapOf(
          text(APP_SETTINGS_LIMITS.valueCharsMax, { charsMin: 1 }),
          APP_SETTINGS_LIMITS.settingsMax,
          'a setting id declared by the app manifest',
          SETTING_ID,
        ),
        APP_SETTINGS_LIMITS.appsMax,
        'an installed app id',
        APP_ID,
      ),
      `Values by app id, then setting id: text or an http(s) address, at most ${APP_SETTINGS_LIMITS.settingsMax} per app and ${APP_LIMITS.appsMax} apps. An empty value is removed, not stored.`,
      { required: true, commands: ['apps settings set'] },
    ),
  },
  empty: { version: 1, apps: {} },
  validate: (source): void => {
    parseAppSettingsFileSource(source, parseAppId);
  },
  serialize: (document): string => serializeAppSettingsFile(parseAppSettingsFileSource(JSON.stringify(document), parseAppId)),
  commands: ['apps settings set'],
  parserSources: ['shared/properties/appSettings.ts', 'electron/project/appSettingsStore.ts'],
  parserKeyExceptions: {
    id: 'A manifest key: the setting declaration id, read from stacki-app.json.',
    kind: 'A manifest key: the declaration kind (text, secret, url), not a settings file key.',
    required: 'A manifest key: whether the declared setting must have a value.',
    advanced: 'A manifest key: whether the declared setting sits under Advanced.',
    label: 'A manifest key: the declared setting label.',
    description: 'A manifest key: the declared setting description.',
    placeholder: 'A manifest key: the declared setting example text.',
  },
};
