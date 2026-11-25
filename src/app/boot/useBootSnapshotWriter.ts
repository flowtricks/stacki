// Keeps the boot snapshot current while a project is open: its page list, the open page and the left panel,
// sent to main after a short quiet so a burst of changes is one message. Only a project whose scan has settled is
// written, so a half-loaded state never replaces a good snapshot.
import { useEffect } from 'react';
import type { ScanResult } from '../../../shared/properties/projectScan';
import { BOOT_SNAPSHOT_VERSION, type BootBranch, type BootSnapshot } from '../../../shared/properties/bootSnapshot';
import type { LeftTab, ProjectIdentity } from '../appTypes';
import { saveBootSnapshot } from '../../lib/bootSeed';
import { knownBranchStatus } from '../../features/git/BranchIndicator';

/** How long state must stay still before it is sent. */
export const SNAPSHOT_QUIET_MS = 1_000;

export interface SnapshotInput {
  readonly project: ProjectIdentity | undefined;
  readonly scan: ScanResult;
  readonly pageName: string | undefined;
  readonly leftTab: LeftTab;
  readonly branch?: BootBranch | undefined;
}

/** The snapshot for `input`, or undefined when there is nothing settled to keep. */
export function snapshotOf(input: SnapshotInput): BootSnapshot | undefined {
  if (input.project === undefined || input.scan.pages.length === 0) {
    return undefined;
  }
  return {
    version: BOOT_SNAPSHOT_VERSION,
    projectPath: input.project.path,
    scan: input.scan,
    ...(input.pageName === undefined ? {} : { pageName: input.pageName }),
    ...(input.leftTab === undefined ? {} : { leftTab: input.leftTab }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  };
}

export function useBootSnapshotWriter(input: SnapshotInput): void {
  const { project, scan, pageName, leftTab } = input;
  useEffect(() => {
    // Read when the quiet ends, not when the effect runs: git answers after the scan and the branch should be in.
    const snapshot = snapshotOf({ project, scan, pageName, leftTab });
    if (snapshot === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      const status = knownBranchStatus(snapshot.projectPath);
      saveBootSnapshot(status === undefined || status.kind === 'unknown' ? snapshot : { ...snapshot, branch: status });
    }, SNAPSHOT_QUIET_MS);
    return () => clearTimeout(timer);
  }, [project, scan, pageName, leftTab]);
}
