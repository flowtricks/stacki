// Project files the demo keeps in the browser that no room holds: project settings the
// bake did not have (a first `.stacki/guide.json`, say) and uploaded assets. Each one is
// saved with the visitor's other edits, so it survives a reload and Reset clears it.
import { assert } from '../vendor/stacki/shared/core/assert';
import type { SavedFiles } from './store';

export const UPLOAD_LIMITS = {
  /** The server's own cap on one upload. */
  bytesMax: 20_000_000,
  /** Browser storage is shared with the site; a demo needs a handful. */
  filesMax: 50,
} as const satisfies Record<string, number>;

/** What `/studio/api/assets` lists for one file. */
export interface AssetEntry {
  readonly rel: string;
  readonly abs: string;
  readonly name: string;
  readonly parent: string;
  readonly root: string;
  readonly isDir: false;
  readonly size: number;
}

export type SaveFile = (file: string, value: string | Blob) => void;

export class DemoFiles {
  private readonly texts: Map<string, string>;
  private readonly blobs: Map<string, Blob>;
  private readonly urls = new Map<string, string>();

  constructor(
    saved: SavedFiles,
    private readonly save: SaveFile,
  ) {
    this.texts = new Map(saved.texts);
    this.blobs = new Map([...saved.blobs].slice(0, UPLOAD_LIMITS.filesMax));
  }

  text(file: string): string | undefined {
    return this.texts.get(file);
  }

  setText(file: string, text: string): void {
    this.texts.set(file, text);
    this.save(file, text);
    assert(this.texts.get(file) === text, 'A settings file reads back as written');
  }

  hasUpload(file: string): boolean {
    return this.blobs.has(file);
  }

  /** Stores an upload. The caller has checked the name, the size and the count. */
  addUpload(file: string, blob: Blob): void {
    assert(!this.blobs.has(file), 'An upload never replaces another');
    assert(this.blobs.size < UPLOAD_LIMITS.filesMax, 'Uploads stay under their count limit');
    this.blobs.set(file, blob);
    this.save(file, blob);
  }

  uploadCount(): number {
    return this.blobs.size;
  }

  uploads(): readonly AssetEntry[] {
    return [...this.blobs].map(([file, blob]) => uploadEntry(file, blob.size));
  }

  /** A URL this page can load the upload from, made once per file. */
  uploadURL(file: string): string | undefined {
    const blob = this.blobs.get(file);
    if (blob === undefined) {
      return undefined;
    }
    const known = this.urls.get(file);
    if (known !== undefined) {
      return known;
    }
    const url = URL.createObjectURL(blob);
    this.urls.set(file, url);
    return url;
  }
}

export function uploadEntry(file: string, size: number): AssetEntry {
  const slash = file.lastIndexOf('/');
  assert(slash > 0, 'An upload sits in a folder');
  return {
    rel: file,
    abs: file,
    name: file.slice(slash + 1),
    parent: file.slice(0, slash),
    root: file.slice(0, file.indexOf('/')),
    isDir: false,
    size,
  };
}
