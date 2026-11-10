// Where media hosting connections live: one JSON file in the app's data folder
// (`media-connections.json`), keyed by the project's real path — the same
// pattern as CMS connections (content/cmsConnectionStore.ts). A connection's
// keys are held only encrypted, by the operating system's own store (Electron
// safeStorage: the macOS Keychain, DPAPI on Windows, the Secret Service on
// Linux), and nothing is saved when that is not available.
//
// Not in the project: `.stacki/` is committed to Git, and a key there would be
// published with the site.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import {
  MEDIA_HOSTING_LIMITS,
  parseMediaConnection,
  parseMediaSecret,
  type MediaConnection,
  type MediaConnectionDraft,
  type MediaConnectionList,
  type MediaSecret,
} from '../../../shared/properties/mediaHosting';
import type { CmsCrypt } from '../cmsConnectionStore';

const STORE_FILE = 'media-connections.json';
const STORE_VERSION = 1;
// Projects one store remembers; the oldest beyond this are not kept.
const STORE_PROJECTS_MAX = 512;
const STORE_BYTES_MAX = 4 * 1024 * 1024;
// An encrypted key pair, base64: the JSON of two bounded keys and its envelope.
const ENCRYPTED_CHARS_MAX = 16_384;

interface StoredConnection {
  readonly connection: MediaConnection;
  /** The keys, as JSON, encrypted, base64. */
  readonly secret: string;
}
type StoreData = Readonly<Record<string, readonly StoredConnection[]>>;

export class MediaConnectionStore {
  constructor(
    private readonly crypt: CmsCrypt,
    /** The app's data folder, read when first needed (it is set once the app is ready). */
    private readonly folder: () => string,
  ) {}

  list(projectRoot: string): MediaConnectionList {
    const stored = this.read()[projectRoot] ?? [];
    return {
      encryption: this.crypt.available() ? 'available' : 'unavailable',
      connections: stored.map((entry) => entry.connection),
    };
  }

  /** Saves a connection with its keys; one for the same bucket or zone replaces the old one. */
  save(projectRoot: string, draft: MediaConnectionDraft): MediaConnection {
    if (!this.crypt.available()) {
      throw new Error('This computer cannot encrypt keys for Stacki, so none are saved. On Linux, install and unlock a keyring (GNOME Keyring or KWallet).');
    }
    const { secret, ...fields } = draft;
    const connection = parseMediaConnection({ ...fields, id: randomUUID() });
    const data = this.read();
    const others = (data[projectRoot] ?? []).filter((entry) => !sameTarget(entry.connection, connection));
    if (others.length >= MEDIA_HOSTING_LIMITS.connectionsPerProjectMax) {
      throw new Error('This project already has the most media connections Stacki keeps.');
    }
    const encrypted = this.crypt.encrypt(JSON.stringify(secret)).toString('base64');
    assert(encrypted.length <= ENCRYPTED_CHARS_MAX, 'An encrypted key stays within its size');
    this.write({ ...data, [projectRoot]: [...others, { connection, secret: encrypted }] });
    assert(JSON.stringify(this.secret(projectRoot, connection.id)) === JSON.stringify(secret), 'Saved keys read back');
    return connection;
  }

  remove(projectRoot: string, id: string): void {
    const data = this.read();
    const kept = (data[projectRoot] ?? []).filter((entry) => entry.connection.id !== id);
    this.write({ ...data, [projectRoot]: kept });
  }

  /** The connection with its keys decrypted; main process only. */
  connection(projectRoot: string, id: string): { readonly connection: MediaConnection; readonly secret: MediaSecret | undefined } | undefined {
    const entry = (this.read()[projectRoot] ?? []).find((item) => item.connection.id === id);
    return entry === undefined ? undefined : { connection: entry.connection, secret: this.secret(projectRoot, id) };
  }

  private secret(projectRoot: string, id: string): MediaSecret | undefined {
    const entry = (this.read()[projectRoot] ?? []).find((item) => item.connection.id === id);
    if (!entry || !this.crypt.available()) {
      return undefined;
    }
    // A locked keychain or keys encrypted on another machine read as none.
    try {
      const parsed: unknown = JSON.parse(this.crypt.decrypt(Buffer.from(entry.secret, 'base64')));
      return parseMediaSecret(parsed);
    } catch {
      return undefined;
    }
  }

  private file(): string {
    return path.join(this.folder(), STORE_FILE);
  }

  // A missing or damaged file reads as no connections: the keys in it are
  // already unusable, and the person can connect again.
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
    assert(body.length <= STORE_BYTES_MAX, 'Media connection store stays within its size');
    const file = this.file();
    const temporary = `${file}.${process.pid}.tmp`;
    // Owner-only: the keys are encrypted, but the file says where a site's media is.
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

// One connection per bucket (R2, S3) or storage zone (Bunny).
function sameTarget(left: MediaConnection, right: MediaConnection): boolean {
  if (left.kind === 'r2' && right.kind === 'r2') {
    return left.accountId === right.accountId && left.bucket === right.bucket;
  }
  if (left.kind === 'bunny' && right.kind === 'bunny') {
    return left.storageZone === right.storageZone;
  }
  if (left.kind === 's3' && right.kind === 's3') {
    return left.endpoint === right.endpoint && left.bucket === right.bucket;
  }
  return false;
}

function parseStore(input: unknown): StoreData {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Media store: expected an object');
  }
  if (Reflect.get(input, 'version') !== STORE_VERSION) {
    throw new Error('Media store: unknown version');
  }
  const projects: unknown = Reflect.get(input, 'projects');
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
    throw new Error('Media store: expected projects');
  }
  const out: Record<string, StoredConnection[]> = {};
  for (const [root, entries] of Object.entries(projects).slice(0, STORE_PROJECTS_MAX)) {
    if (!Array.isArray(entries)) {
      throw new Error('Media store: expected a list');
    }
    out[root] = entries.slice(0, MEDIA_HOSTING_LIMITS.connectionsPerProjectMax).map(parseStoredConnection);
  }
  return out;
}

function parseStoredConnection(input: unknown): StoredConnection {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Media store: expected a connection');
  }
  const secret: unknown = Reflect.get(input, 'secret');
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > ENCRYPTED_CHARS_MAX) {
    throw new Error('Media store: expected encrypted keys');
  }
  return { connection: parseMediaConnection(Reflect.get(input, 'connection')), secret };
}
