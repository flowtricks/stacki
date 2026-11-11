// An app's commands in its details popup (docs/apps.md, "Shortcuts and commands"):
// a dense list, one line per command, its title on the left (cut short, the whole
// title on hover) and on the right, for an admin, a content-width shortcut
// recorder (src/ui/ShortcutRecorder.tsx); anyone else sees the key as text. A key
// an earlier app holds marks the row with an amber dot and says who holds it in
// the row's hint. The recorder takes only keys in the reserved range and refuses
// one another command holds ("Used by …") rather than swapping: a swap would
// silently move another app's key, and a refusal names the holder so the person
// can free it there first. Its reset button puts the app's own key back. Rebinds
// are kept per person and project (appCommands.ts says why).
import type { AppSummary } from '../../../shared/properties/apps';
import { isReservedShortcut } from '../../../shared/properties/appShortcuts';
import { assert } from '../../../shared/core/assert';
import { ShortcutRecorder } from '../../ui/ShortcutRecorder';
import { AppDetailsItem, AppDetailsList, AppDetailsSection } from './AppDetailsLayout';
import {
  commandShortcutHint,
  platformShortcutLabel,
  rebindCommand,
  rebindFor,
  shortcutHolder,
  shortcutPlatform,
  useAppCommands,
  type BoundCommand,
} from './appCommands';

/** The details popup's "Commands" section; nothing for an app without commands. */
export function AppCommandSettings({ app, admin }: { readonly app: AppSummary; readonly admin: boolean }) {
  const bound = useAppCommands();
  const commands = bound.filter((entry) => entry.app.manifest.id === app.manifest.id);
  if (commands.length === 0) {
    return undefined;
  }
  assert(
    commands.every((entry) => entry.command.title.length > 0),
    'Every command has a title',
  );
  const platform = shortcutPlatform();
  const hint = commandShortcutHint(platform);
  return (
    <AppDetailsSection title="Commands" hint="Run from the command palette, or anywhere in the editor with their keys.">
      <AppDetailsList label={`${app.manifest.name} commands`}>
        {commands.map((entry) => {
          const appId = app.manifest.id;
          const commandId = entry.command.id;
          const held = heldNote(entry);
          return (
            <AppDetailsItem key={commandId} label={entry.command.title} {...(held === undefined ? {} : { hint: held, tone: 'warning' as const })}>
              {admin ? (
                <ShortcutRecorder
                  ariaLabel={`Shortcut for ${entry.command.title}`}
                  value={wantedShortcut(entry)}
                  emptyLabel="None"
                  platform={platform}
                  format={platformShortcutLabel}
                  hint={hint}
                  accepts={isReservedShortcut}
                  conflict={(shortcut) => shortcutHolder(bound, appId, commandId, shortcut)}
                  reset={entry.rebind === undefined ? undefined : { label: 'Use the app’s own key', onReset: () => rebindCommand(appId, commandId, undefined) }}
                  onClear={() => rebindCommand(appId, commandId, rebindFor(entry.command, undefined))}
                  onChange={(shortcut) => {
                    // The recorder only hands back what `accepts` took.
                    assert(isReservedShortcut(shortcut), 'A recorded command key is in the reserved range');
                    rebindCommand(appId, commandId, rebindFor(entry.command, shortcut));
                  }}
                />
              ) : (
                <span className="apps-details-shortcut">{shortcutText(entry)}</span>
              )}
            </AppDetailsItem>
          );
        })}
      </AppDetailsList>
    </AppDetailsSection>
  );
}

/** The key a command asks for, whether or not an earlier app holds it: the field shows the person's choice. */
function wantedShortcut({ shortcut, inUse }: BoundCommand): string | undefined {
  return inUse === undefined ? shortcut : inUse.shortcut;
}

/** Why a command's key does not run it, when an earlier app holds that key; undefined when it is free. */
function heldNote({ inUse }: BoundCommand): string | undefined {
  if (inUse === undefined) {
    return undefined;
  }
  assert(inUse.holder.length > 0, 'A key in use names its holder');
  return `${platformShortcutLabel(inUse.shortcut)} is in use by ${inUse.holder}, installed first.`;
}

/** The key as a non-admin sees it: read-only text. */
function shortcutText(entry: BoundCommand): string {
  const wanted = wantedShortcut(entry);
  return wanted === undefined ? 'None' : platformShortcutLabel(wanted);
}
