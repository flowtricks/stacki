// Where each installed app lives, for the Apps panel's rows and the details'
// About section: "Local", or "GitHub" with the repository's visibility, plus
// "Marketplace" when the index lists the app (shared/properties/appPlace.ts).
// The host answers each GitHub app's repository and visibility (cached there);
// the marketplace match reads the index the Marketplace tab reads, and only for
// a role that may see the marketplace. Every lookup that fails says nothing: the
// pills fall back to what the lockfile alone tells.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppSummary } from '../../../shared/properties/apps';
import { appListedInMarketplace, appPlacePills, type AppPill, type AppRepositoryPlace } from '../../../shared/properties/appPlace';
import type { MarketplaceIndex } from '../../../shared/properties/appMarketplace';
import { loadAppRepositoryPlace, loadMarketplace } from '../../ipc/appMarketplaceBridge';
import { useDelayedTooltip } from '../../ui/delayedTooltip';

/** What the pills of one app say beyond its lockfile. */
export interface AppPlaceFacts {
  /** Its GitHub repository and visibility, once the host answered; undefined before, on failure, or for a local app. */
  readonly place: AppRepositoryPlace | undefined;
  /** Whether the marketplace index lists it, by id and repository. */
  readonly listed: boolean;
}

export const NO_APP_PLACE_FACTS: AppPlaceFacts = { place: undefined, listed: false };

/**
 * The facts for every listed app, keyed by app id. Looked up again only when the
 * project, the marketplace permission or an app's source changes, not on every
 * reload of the list.
 */
export function useAppPlaces(projectPath: string, apps: readonly AppSummary[], options: { readonly marketplace: boolean }): ReadonlyMap<string, AppPlaceFacts> {
  // The sources that decide a lookup, as one stable key: a reload with the same apps asks nothing again.
  const signature = useMemo(() => JSON.stringify(apps.map((app) => [app.manifest.id, app.lock.source])), [apps]);
  const marketplace = options.marketplace;
  // The panel opens on the pills it last drew for the same apps: starting empty
  // drew "GitHub" and then "GitHub · Private" a moment later, on every open.
  const [facts, setFacts] = useState<ReadonlyMap<string, AppPlaceFacts>>(() => keptFacts(projectPath, { signature, marketplace }));
  useEffect(() => {
    const remote = apps.filter((app) => onGitHub(app));
    if (remote.length === 0) {
      setFacts(new Map());
      return;
    }
    let current = true;
    void lookUpPlaces(projectPath, remote, { marketplace }).then((found) => {
      keepFacts(projectPath, { signature, marketplace, facts: found });
      if (current) {
        setFacts(found);
      }
    });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for `apps`: a reload with the same sources must not ask GitHub again.
  }, [projectPath, signature, marketplace]);
  return facts;
}

// The last facts per project, with the apps and permission they were looked up for.
const KEPT_FACTS_PROJECTS_MAX = 8;
interface KeptFacts {
  readonly signature: string;
  readonly marketplace: boolean;
  readonly facts: ReadonlyMap<string, AppPlaceFacts>;
}
const keptFactsByProject = new Map<string, KeptFacts>();

function keptFacts(projectPath: string, lookup: Pick<KeptFacts, 'signature' | 'marketplace'>): ReadonlyMap<string, AppPlaceFacts> {
  const kept = keptFactsByProject.get(projectPath);
  if (kept === undefined) {
    return new Map();
  }
  // Facts looked up for other apps or another permission would draw the wrong pills.
  if (kept.signature === lookup.signature) {
    if (kept.marketplace === lookup.marketplace) {
      return kept.facts;
    }
  }
  return new Map();
}

function keepFacts(projectPath: string, kept: KeptFacts): void {
  keptFactsByProject.delete(projectPath);
  keptFactsByProject.set(projectPath, kept);
  const oldest = keptFactsByProject.keys().next().value;
  if (keptFactsByProject.size > KEPT_FACTS_PROJECTS_MAX) {
    assert(oldest !== undefined, 'useAppPlaces: a full cache has an oldest project');
    keptFactsByProject.delete(oldest);
  }
  assert(keptFactsByProject.size <= KEPT_FACTS_PROJECTS_MAX, 'useAppPlaces: the kept facts stay within their bound');
}

/** The row's place pills; hovering one explains it. */
export function AppPlacePills({ app, facts }: { readonly app: AppSummary; readonly facts: AppPlaceFacts }) {
  const pills = appPlacePills(app.lock.source, facts);
  return (
    <span className="apps-row-places">
      {pills.map((pill) => (
        <AppPlacePill key={pill.kind} pill={pill} />
      ))}
    </span>
  );
}

function AppPlacePill({ pill }: { readonly pill: AppPill }) {
  const tooltip = useDelayedTooltip();
  return (
    <>
      <span className="apps-badge muted apps-place-pill" data-place={pill.kind} onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
        {pill.label}
      </span>
      {/* The pill sits inside the row's button, where a block is invalid; the tip goes to the body. */}
      {tooltip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={tooltip.value}>
            {pill.tooltip}
          </div>,
          document.body,
        )}
    </>
  );
}

function onGitHub(app: AppSummary): boolean {
  const kind = app.lock.source.kind;
  return kind === 'github' || kind === 'marketplace';
}

async function lookUpPlaces(
  projectPath: string,
  apps: readonly AppSummary[],
  options: { readonly marketplace: boolean },
): Promise<ReadonlyMap<string, AppPlaceFacts>> {
  assert(apps.length <= APP_LIMITS.appsMax, 'Place lookups are bounded by the installed apps');
  const [index, places] = await Promise.all([
    options.marketplace ? readIndex(projectPath) : Promise.resolve(undefined),
    Promise.all(apps.map((app) => readPlace(projectPath, app.manifest.id))),
  ]);
  const found = new Map<string, AppPlaceFacts>();
  apps.forEach((app, position) => {
    const listed = index === undefined ? false : appListedInMarketplace(index, { id: app.manifest.id, source: app.lock.source });
    found.set(app.manifest.id, { place: places[position], listed });
  });
  assert(found.size <= apps.length, 'One entry per app');
  return found;
}

async function readIndex(projectPath: string): Promise<MarketplaceIndex | undefined> {
  try {
    const answer = await loadMarketplace(projectPath, { refresh: false });
    return answer.ok ? answer.value : undefined;
  } catch {
    // An unreadable index only means no "Marketplace" pill; the tab says why.
    return undefined;
  }
}

async function readPlace(projectPath: string, id: string): Promise<AppRepositoryPlace | undefined> {
  try {
    const answer = await loadAppRepositoryPlace(projectPath, id);
    return answer.ok ? answer.value.place : undefined;
  } catch {
    // A failed lookup shows no visibility, never an error.
    return undefined;
  }
}
