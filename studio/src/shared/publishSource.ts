// Disk manifests cross repository interfaces; Node implementation imports stay outside Worker graphs.
export interface PublishGit {
  readonly directory: string;
  readonly root: string;
  readonly authorization?: string;
}

export interface PublishedFile {
  readonly path: string;
  readonly sha: string;
  readonly mode: '100644' | '100755';
  readonly size: number;
}

export interface PublishSource {
  readonly git: PublishGit;
  readonly tree: string;
  readonly files: readonly PublishedFile[];
  readonly deleted: readonly string[];
  /** The signed-in person's qualified identity, when they are not a GitHub person: named in the commit message. */
  readonly editor?: string | undefined;
}

export interface PublishReceipt {
  readonly sha: string;
  readonly url: string;
}
