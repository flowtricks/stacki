// Where CMS connections live: one JSON file in the app's data folder, keyed by
// the project's real path. A key is held only encrypted, by the operating
// system's own store (Electron safeStorage: the macOS Keychain, DPAPI on
// Windows, the Secret Service on Linux), and nothing is saved when that is not
// available — a key on disk in the clear is not something to fall back to.
//
// Not in the project: `.stacki/` is committed to Git, and a key there would be
// published with the site. The public half of a connection (which CMS, which
// project and dataset) is not secret, but it sits with its key so the two
// cannot drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import {
  CMS_CONNECTION_LIMITS,
  parseCmsConnection,
  type CmsConnection,
  type CmsConnectionDraft,
  type CmsConnectionList,
} from '../../shared/properties/cmsConnections';

/** The operating system's encryption, as Electron's safeStorage offers it. */
export interface CmsCrypt {
  readonly available: () => boolean;
  readonly encrypt: (text: string) => Buffer;
  readonly decrypt: (data: Buffer) => string;
}

const STORE_FILE = 'cms-connections.json';
const STORE_VERSION = 1;
// Projects one store remembers; the oldest beyond this are not kept.
const STORE_PROJECTS_MAX = 512;
const STORE_BYTES_MAX = 4 * 1024 * 1024;

interface StoredConnection {
  readonly connection: CmsConnection;
  /** The key, encrypted, base64. */
  readonly secret: string;
}
type StoreData = Readonly<Record<string, readonly StoredConnection[]>>;

export class CmsConnectionStore {
  constructor(
    private readonly crypt: CmsCrypt,
    /** The app's data folder, read when first needed (it is set once the app is ready). */
    private readonly folder: () => string,
  ) {}

  list(projectRoot: string): CmsConnectionList {
    const stored = this.read()[projectRoot] ?? [];
    return {
      encryption: this.crypt.available() ? 'available' : 'unavailable',
      connections: stored.map((entry) => entry.connection),
    };
  }

  /** Saves a connection with its key; one of a kind and target replaces the old one. */
  save(projectRoot: string, draft: CmsConnectionDraft): CmsConnection {
    if (!this.crypt.available()) {
      throw new Error(
        'This computer cannot encrypt keys for Stacki, so none are saved. ' +
          'On Linux, install and unlock a keyring (GNOME Keyring or KWallet).',
      );
    }
    const { secret, ...fields } = draft;
    const connection = parseCmsConnection({ ...fields, id: randomUUID() });
    const data = this.read();
    const others = (data[projectRoot] ?? []).filter(
      (entry) => !sameTarget(entry.connection, connection),
    );
    if (others.length >= CMS_CONNECTION_LIMITS.connectionsPerProjectMax) {
      throw new Error('This project already has the most CMS connections Stacki keeps.');
    }
    const encrypted = this.crypt.encrypt(secret).toString('base64');
    this.write({ ...data, [projectRoot]: [...others, { connection, secret: encrypted }] });
    assert(this.secret(projectRoot, connection.id) === secret, 'A saved key reads back');
    return connection;
  }

  remove(projectRoot: string, id: string): void {
    const data = this.read();
    const kept = (data[projectRoot] ?? []).filter((entry) => entry.connection.id !== id);
    this.write({ ...data, [projectRoot]: kept });
  }

  /** The key of one connection, decrypted; main process only. */
  secret(projectRoot: string, id: string): string | undefined {
    const entry = (this.read()[projectRoot] ?? []).find((item) => item.connection.id === id);
    if (!entry || !this.crypt.available()) {
      return undefined;
    }
    // A locked keychain or a key encrypted on another machine reads as none.
    try {
      return this.crypt.decrypt(Buffer.from(entry.secret, 'base64'));
    } catch {
      return undefined;
    }
  }

  private file(): string {
    return path.join(this.folder(), STORE_FILE);
  }

  // A missing or damaged file reads as no connections: the keys in it are
  // already unusable, and the person can sign in again.
  private read(): StoreData {
    let raw: string;
    try {
      const file = this.file();
      if (fs.statSync(file).size > STORE_BYTES_MAX) {
        return {};
      }
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parseStore(parsed);
    } catch {
      return {};
    }
  }

  private write(data: StoreData): void {
    const projects = Object.entries(data).filter(([, entries]) => entries.length > 0);
    const kept = Object.fromEntries(projects.slice(-STORE_PROJECTS_MAX));
    const body = JSON.stringify({ version: STORE_VERSION, projects: kept });
    assert(body.length <= STORE_BYTES_MAX, 'CMS connection store stays within its size');
    const file = this.file();
    const temporary = `${file}.${process.pid}.tmp`;
    // Owner-only: the keys are encrypted, but the file says which CMS a site uses.
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

// One Sanity connection per project and dataset, one Payload or custom per address.
function sameTarget(left: CmsConnection, right: CmsConnection): boolean {
  if (left.kind === 'sanity' && right.kind === 'sanity') {
    return left.projectId === right.projectId && left.dataset === right.dataset;
  }
  if (left.kind !== 'sanity' && right.kind !== 'sanity') {
    return left.kind === right.kind && left.baseUrl === right.baseUrl;
  }
  return false;
}

function parseStore(input: unknown): StoreData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('CMS store: expected an object');
  }
  if (Reflect.get(input, 'version') !== STORE_VERSION) {
    throw new Error('CMS store: unknown version');
  }
  const projects: unknown = Reflect.get(input, 'projects');
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
    throw new Error('CMS store: expected projects');
  }
  const out: Record<string, StoredConnection[]> = {};
  for (const [root, entries] of Object.entries(projects).slice(0, STORE_PROJECTS_MAX)) {
    if (!Array.isArray(entries)) {
      throw new Error('CMS store: expected a list');
    }
    out[root] = entries
      .slice(0, CMS_CONNECTION_LIMITS.connectionsPerProjectMax)
      .map(parseStoredConnection);
  }
  return out;
}

function parseStoredConnection(input: unknown): StoredConnection {
  if (typeof input !== 'object' || input === null) {
    throw new Error('CMS store: expected a connection');
  }
  const secret: unknown = Reflect.get(input, 'secret');
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > 16_384) {
    throw new Error('CMS store: expected an encrypted key');
  }
  return { connection: parseCmsConnection(Reflect.get(input, 'connection')), secret };
}
