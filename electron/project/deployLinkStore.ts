// Where a custom host's deploy link lives: one file in the app's data folder (`deploy-links.json`), never in a
// project, because `.stacki/` is committed to Git. The link is held only sealed by the operating system's own
// encryption (Electron safeStorage), as CMS and media keys are, and nothing is saved when that is unavailable.
//
// A link is bound to the project folder, the GitHub repository and the destination (production, or one added
// destination's id) it was added for. All three are sealed inside the encrypted value, so neither editing this file nor
// cloning another repository into the same folder can send a link on behalf of anything it was not saved for. A binding
// that does not match is answered, never sent, and a destination is never allowed to hold or send the link of
// production or of another destination.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { maskDeployLink, parseDeployLink, PRODUCTION_LINK, type DeployLinkDestination, type DeployLinkState } from '../../shared/properties/publishDeployLink';
import { DESTINATION_LIMITS, type DestinationId } from '../../shared/properties/publishDestinations';
import { git } from '../lib/nodeTools';

/** The operating system's encryption, as Electron's safeStorage offers it. */
export interface DeployLinkCrypt {
  readonly available: () => boolean;
  readonly encrypt: (text: string) => Buffer;
  readonly decrypt: (data: Buffer) => string;
}

export const DEPLOY_LINK_STORE_LIMITS = {
  /** One entry for each project and destination that has a link. */
  linksMax: 1_024,
  fileBytesMax: 8 * 1024 * 1024,
  sealedCharsMax: 8_192,
} as const satisfies Record<string, number>;

const STORE_FILE = 'deploy-links.json';

type Sealed = Readonly<Record<string, string>>;
type Opened =
  { readonly kind: 'none' } | { readonly kind: 'unavailable' } | { readonly kind: 'other-repository' } | { readonly kind: 'saved'; readonly link: string };

interface Binding {
  readonly project: string;
  readonly repository: string;
}

export class DeployLinkStore {
  constructor(
    private readonly crypt: DeployLinkCrypt,
    /** The app's data folder, read when first needed (it is set once the app is ready). */
    private readonly folder: () => string,
  ) {}

  async state(projectRoot: string, destination: DeployLinkDestination = PRODUCTION_LINK): Promise<DeployLinkState> {
    const opened = await this.openLink(projectRoot, destination);
    return opened.kind === 'saved' ? { kind: 'saved', mask: maskDeployLink(opened.link) } : { kind: opened.kind };
  }

  /** Whether this computer can keep a link at all, which is what a destination without a saved one shows. */
  unsavedState(): DeployLinkState {
    return this.crypt.available() ? { kind: 'none' } : { kind: 'unavailable' };
  }

  /**
   * The link itself, for the one request a publish sends. Main process only; it never crosses IPC. `others` are the
   * project's other destinations, whose links a destination must never send.
   */
  async linkToSend(
    projectRoot: string,
    destination: DeployLinkDestination = PRODUCTION_LINK,
    others: readonly DestinationId[] = [],
  ): Promise<Result<string, Described>> {
    const opened = await this.openLink(projectRoot, destination);
    switch (opened.kind) {
      case 'saved': {
        // Checked again at sending: another link may have been saved after this one. Publishing production is not held
        // back by a destination's link; it is the destination that may not send production's.
        const taken = destination === PRODUCTION_LINK ? undefined : await this.sharedWith(projectRoot, destination, others, opened.link);
        return taken === undefined ? ok(opened.link) : err(taken);
      }
      case 'none':
        return err(described('publish.custom.link.missing'));
      case 'other-repository':
        return err(described('publish.custom.link.otherRepository'));
      case 'unavailable':
        return err(described('publish.custom.link.unavailable'));
      default: {
        const exhaustive: never = opened;
        return exhaustive;
      }
    }
  }

  async save(
    projectRoot: string,
    input: string,
    destination: DeployLinkDestination = PRODUCTION_LINK,
    others: readonly DestinationId[] = [],
  ): Promise<Result<undefined, Described>> {
    const link = parseDeployLink(input);
    if (!link.ok) {
      return link;
    }
    // Fail closed: without the system's encryption the link is not kept at all.
    if (!this.crypt.available()) {
      return err(described('publish.custom.link.unavailable'));
    }
    const taken = await this.sharedWith(projectRoot, destination, others, link.value);
    if (taken !== undefined) {
      return err(taken);
    }
    const binding = await deployLinkBinding(projectRoot);
    const key = linkKey(binding.project, destination);
    try {
      const sealed = this.crypt.encrypt(JSON.stringify({ version: 1, link: link.value, destination, ...binding })).toString('base64');
      assert(sealed.length <= DEPLOY_LINK_STORE_LIMITS.sealedCharsMax, 'A sealed link stays within its size');
      const { [key]: replaced, ...others } = this.read();
      void replaced;
      this.write({ ...others, [key]: sealed });
    } catch {
      // The failure's own words are dropped: an encryption or disk error must never quote what it was given.
      return err(described('publish.custom.link.saveFailed'));
    }
    const saved = await this.openLink(projectRoot, destination);
    assert(saved.kind === 'saved', 'A saved link opens again for the same project');
    assert(saved.link === link.value, 'A saved link reads back unchanged');
    return ok(undefined);
  }

  remove(projectRoot: string, destination: DeployLinkDestination = PRODUCTION_LINK): Result<undefined, Described> {
    const key = linkKey(realProject(projectRoot), destination);
    const { [key]: removed, ...others } = this.read();
    if (removed === undefined) {
      return ok(undefined);
    }
    try {
      this.write(others);
    } catch {
      return err(described('publish.custom.link.saveFailed'));
    }
    assert(this.read()[key] === undefined, 'A removed link is gone');
    return ok(undefined);
  }

  /** Why `destination` may not use `link`: production or one of `others` already does. */
  private async sharedWith(
    projectRoot: string,
    destination: DeployLinkDestination,
    others: readonly DestinationId[],
    link: string,
  ): Promise<Described | undefined> {
    assert(others.length <= DESTINATION_LIMITS.destinationsMax, 'The other destinations stay bounded');
    for (const other of [PRODUCTION_LINK, ...others]) {
      if (other === destination) {
        continue;
      }
      const opened = await this.openLink(projectRoot, other);
      if (opened.kind === 'saved' && opened.link === link) {
        const production = other === PRODUCTION_LINK || destination === PRODUCTION_LINK;
        return described(production ? 'publish.destination.error.productionLink' : 'publish.destination.error.sharedLink');
      }
    }
    return undefined;
  }

  private async openLink(projectRoot: string, destination: DeployLinkDestination): Promise<Opened> {
    const binding = await deployLinkBinding(projectRoot);
    const sealed = this.read()[linkKey(binding.project, destination)];
    // Nothing is decrypted, and the system keychain is not asked, for a project that never saved a link.
    if (sealed === undefined) {
      return this.crypt.available() ? { kind: 'none' } : { kind: 'unavailable' };
    }
    if (!this.crypt.available()) {
      return { kind: 'unavailable' };
    }
    try {
      const parsed: unknown = JSON.parse(this.crypt.decrypt(Buffer.from(sealed, 'base64')));
      const value = record(parsed);
      const link = parseDeployLink(value['link']);
      if (value['version'] !== 1 || !link.ok) {
        return { kind: 'none' };
      }
      // A value moved to another entry of the file answers as unset.
      if (text(value['project']) !== binding.project || value['destination'] !== destination) {
        return { kind: 'none' };
      }
      return text(value['repository']) === binding.repository ? { kind: 'saved', link: link.value } : { kind: 'other-repository' };
    } catch {
      // A locked keychain, or a value sealed on another computer, reads as unset so the person adds it again.
      return { kind: 'none' };
    }
  }

  private file(): string {
    return path.join(this.folder(), STORE_FILE);
  }

  // A missing or damaged file reads as no links: whatever it held can no longer be sent.
  private read(): Sealed {
    try {
      const file = this.file();
      if (fs.statSync(file).size > DEPLOY_LINK_STORE_LIMITS.fileBytesMax) {
        return {};
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const value = record(parsed);
      if (value['version'] !== 1) {
        return {};
      }
      const entries = Object.entries(record(value['links'])).slice(-DEPLOY_LINK_STORE_LIMITS.linksMax);
      return Object.fromEntries(
        entries.flatMap(([key, sealed]) => (typeof sealed === 'string' && sealed.length <= DEPLOY_LINK_STORE_LIMITS.sealedCharsMax ? [[key, sealed]] : [])),
      );
    } catch {
      return {};
    }
  }

  private write(links: Sealed): void {
    const kept = Object.fromEntries(Object.entries(links).slice(-DEPLOY_LINK_STORE_LIMITS.linksMax));
    const body = JSON.stringify({ version: 1, links: kept });
    assert(body.length <= DEPLOY_LINK_STORE_LIMITS.fileBytesMax, 'The deploy link store stays within its size');
    const file = this.file();
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

/** The project and repository a link belongs to. A project with no origin yet binds to that, and rebinding is manual. */
export async function deployLinkBinding(projectRoot: string): Promise<Binding> {
  const project = realProject(projectRoot);
  const origin = await git(project, ['config', '--get', 'remote.origin.url'])
    .then((result) => result.stdout.trim())
    .catch(() => '');
  return { project, repository: repositoryIdentity(origin) };
}

/** One identity for the HTTPS and SSH spellings of a GitHub repository, whose names ignore case. */
export function repositoryIdentity(origin: string): string {
  const match = /^(?:https:\/\/(?:[^/@]*@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin);
  return match?.[1] === undefined ? origin : `github.com/${match[1].toLowerCase()}`;
}

// One folder must give one key however it was spelled. The publisher resolves a project with the operating system's
// resolver (`fs/promises.realpath`), so this asks the same one. Node's JavaScript `fs.realpathSync` keeps the spelling
// it was given for a Windows short (8.3) name, a mapped or substituted drive, and the letter case on a disk that
// ignores case: a link saved through it would then be reported missing at publishing.
function realProject(projectRoot: string): string {
  assert(path.isAbsolute(projectRoot), 'A project root is absolute');
  return fs.realpathSync.native(projectRoot);
}

function linkKey(project: string, destination: DeployLinkDestination): string {
  return createHash('sha256').update(`${destination}\0${project}`).digest('hex');
}
