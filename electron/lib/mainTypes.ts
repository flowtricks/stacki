// Main-process state is owned here; mutable fields never cross IPC by reference.
import type { ChildProcess } from 'child_process';
import type { Data } from '../../shared/core/boundary';

export interface RecentProject {
  readonly path: string;
  readonly name: string;
  readonly openedAt: number;
}
export type AssetEntry = {
  readonly rel: string;
  readonly name: string;
  readonly parent: string;
  readonly root: string;
} & ({ readonly isDir: true; readonly isRoot?: true } | { readonly isDir: false; readonly size: number; readonly abs: string });
export interface CmsFile {
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly abs: string;
  readonly fromFile?: boolean;
  readonly fromPage?: boolean;
  readonly size?: number;
  readonly data?: unknown;
  readonly error?: string;
}
export interface StyleFile {
  readonly rel: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
}
export interface GitInfo {
  isRepo: true;
  branch: string;
  branches: string[];
  remote: string | undefined;
  dirty: boolean;
  ahead: number;
  parked: string[];
  head?: string | undefined;
  userEmail?: string | undefined;
  trunk?: string | undefined;
  defaultBranch?: string | undefined;
  dirtyFiles?: string[];
  hasUpstream?: boolean;
}
// Null remains the existing process-lifecycle sentinel and wire representation.
export type DevServer = {
  readonly url: string;
  readonly projectPath: string;
  readonly bare?: true;
} & (
  | {
      readonly proc: ChildProcess;
      readonly bin: string;
      readonly daemon?: false;
      readonly external?: false;
    }
  | {
      readonly proc: undefined;
      readonly bin: string;
      readonly daemon: true;
      readonly external?: false;
    }
  | {
      readonly proc: undefined;
      readonly external: true;
      readonly daemon?: false;
      readonly bin?: never;
    }
);
export interface PreviewServer {
  readonly proc: ChildProcess;
  readonly url: string;
  readonly ref: string;
  readonly port: number;
}
export interface DynamicEntry {
  readonly params: Readonly<Record<string, Data>>;
  readonly props: Data;
}
