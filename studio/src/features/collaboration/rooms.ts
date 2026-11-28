import { verifyGitWorkspaceLease } from '../history/gitWorkspaceLease';
import { loadInsertionDefaults } from '../settings/loadDefaults';
import { leftOutAssets } from '../source/instanceDefaults';
import { resolveImport } from '../source/imports';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { maintainConnection } from './connectionLease';
import { parseSaveSequence } from './saveProtocol';
import { selectionRequest } from './selectionIntent';
import { actionSelection } from '../navigator/actionSelection';
import { captureSelectionPositions } from './selectionPositions';
import type { PublishState } from '../publishing/publish';
import { occurrenceOf, type Peer } from './presence';
import { selectionOwner, releaseSelectionOwners } from './selectionLock';
import { ReferencedError, errorWire } from '../../shared/referencedError';
import type { GitHubProfile } from '../auth/profile';
import * as Y from 'yjs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { PresenceColors } from './presenceColors';
import { CursorRelay } from './cursorRelay';
import { sourceRenderMode, type SourceRenderMode } from '../preview/sourceRenderMode';
import type { CursorPacket } from './cursorPresence';
import { writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_SOURCE, record, sourcePath, string, textChange } from '../../shared/validation';
import { pasteEdits } from '../source/paste';
import { structuralEdits } from '../source/sourceOperations';
import { applyEdits, parseAction } from '../source/source';
import { BatchedWriter } from '../storage/batchedWriter';
import { DraftStorage } from '../storage/draftStorage';
import { SerialQueue } from '../../shared/serialQueue';
import { readSource, preparePath } from '../project/projectServer';
import { ADMIN_VIEW, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { assertComponentInsertAllowed, assertDocumentActionAllowed, assertDocumentChangeAllowed, assertEditorContentAllowed } from '../roles/documentAccess';
import { EditorUndo } from '../roles/editorUndo';
import { CodeGuard, writesCode } from '../roles/codeGuard';
import { limitsEditing } from '../../../vendor/stacki/shared/properties/projectRoles';

/** A person signed in by another authentication provider: presence by name and a provider-qualified key, no GitHub avatar. */
export interface ProviderPresence {
  readonly key: string;
  readonly login: string;
}

/** Resolves the role a connection edits as; the server derives it from the signed-in person (requestPerson.ts). */
export type ConnectionRole = () => Promise<RoleView>;
/** Rooms opened without an identity (tests, a single local editor) edit as admin, as a local Studio does. */
const ADMIN_CONNECTION: ConnectionRole = () => Promise.resolve(ADMIN_VIEW);

interface LivePresence {
  readonly written?: (file: string, mode: SourceRenderMode) => void;
  readonly publishing?: () => PublishState;
  readonly colors: PresenceColors;
  readonly broadcast: (packet: CursorPacket) => void;
  readonly snapshot: () => readonly CursorPacket[];
}

interface SourceSnapshot {
  readonly source: string;
  readonly bytes: Uint8Array;
  readonly scheduling: 'classify' | 'immediate';
}

interface Incoming {
  readonly socket: WebSocket;
  readonly message: Record<string, unknown>;
}

/** Waiting edits taken together at most; the queue itself stays bounded by its own limit. */
const BATCH_MAX = 100;

export class Room {
  readonly document = new Y.Doc();
  readonly text = this.document.getText('source');
  readonly clients = new Map<WebSocket, Peer>();
  // Kept apart from `clients`: peers are broadcast as presence, roles are not.
  private readonly roles = new Map<WebSocket, ConnectionRole>();
  // Who each connection is across reconnects, and what a limited role may undo (editorUndo.ts).
  private readonly people = new Map<WebSocket, string>();
  private readonly editorUndo = new EditorUndo();
  readonly cursors: CursorRelay;
  private readonly colors: PresenceColors;
  private queue = Promise.resolve();
  // Messages waiting their turn, in order. Each has one turn in `queue`; a turn may take the edits right behind it.
  private readonly inbox: Incoming[] = [];
  // Turns still to be taken one at a time, after a batch that could not be taken together.
  private alone = 0;
  private saved = '';
  private closed = false;
  private revision = 0;
  private queued = 0;
  readonly durable: BatchedWriter<SourceSnapshot>;
  private readonly storage: DraftStorage;
  constructor(
    readonly root: string,
    readonly file: string,
    readonly coordinator = new SerialQueue(),
    private readonly publishPresence?: () => void,
    private readonly live?: LivePresence,
    // One per workspace, so code one document held can be pasted into another (codeGuard.ts).
    private readonly guard = new CodeGuard(root),
  ) {
    this.colors = live?.colors ?? new PresenceColors();
    this.cursors = new CursorRelay(this.clients, (packet) => {
      if (live) {
        live.broadcast(packet);
      } else {
        this.broadcastCursor(packet);
      }
    });
    this.storage = new DraftStorage(root);
    // Projection and persistence share one bounded writer. Keystrokes must not
    // queue behind disk I/O or trigger an Astro rebuild for every character.
    this.durable = new BatchedWriter((snapshot) => this.writeSnapshot(snapshot), 300);
  }
  async initialize() {
    const source = await readSource(this.root, this.file);
    const snapshot = await this.storage.read(this.file);
    if (snapshot) {
      Y.applyUpdate(this.document, snapshot);
    }
    if (!snapshot) {
      this.text.insert(0, source);
    }
    // A restarted process must not replace external disk edits with an old cached snapshot.
    else if (!process.env['STUDIO_BACKEND_URL'] && this.text.toString() !== source) {
      this.replace(source, 'disk');
    }
    if (!this.document.getMap('metadata').get('epoch')) {
      this.document.getMap('metadata').set('epoch', randomUUID());
    }
    this.saved = source;
    // Persist the initial CRDT identity before any client sees it. Otherwise a server
    // restart can seed identical text with new IDs and duplicate it on reconnection.
    await this.persist();
  }
  attach(
    socket: WebSocket,
    identity?: GitHubProfile | ProviderPresence,
    authorize?: () => Promise<boolean>,
    participant?: string,
    role: ConnectionRole = ADMIN_CONNECTION,
  ) {
    if (this.clients.size >= 30) {
      socket.close(1013, 'Room is full');
      return;
    }
    const id = randomUUID();
    const key = identity
      ? 'id' in identity
        ? `github:${identity.id}`
        : identity.key
      : `local:${participant && /^[a-f0-9-]{36}$/i.test(participant) ? participant : id}`;
    this.clients.set(socket, {
      id,
      color: this.colors.acquire(key),
      // i18n-ignore: the default display name of an anonymous collaborator, sent to other editors as data.
      name: identity?.login ?? 'Editor',
      selection: '',
      file: this.file,
      page: this.file,
      occurrence: 0,
      updatedAt: Date.now(),
      ...(identity && 'id' in identity ? { githubId: identity.id } : {}),
    });
    this.roles.set(socket, role);
    this.people.set(socket, key);
    maintainConnection(socket, identity ? (authorize ?? (async () => false)) : undefined);
    // Only a head start: a page it cannot read is read again, and refused or not, by the first edit's own check.
    void role()
      .then((view) => this.guard.warm(view, this.file, this.text.toString()))
      .catch(() => undefined);
    this.synchronize(socket);
    this.presence();
    socket.on('message', (bytes, binary) => this.receiveMessage(socket, bytes, binary));
    socket.on('close', () => this.detach(socket, key));
    socket.on('error', () => this.detach(socket, key));
  }
  private receiveMessage(socket: WebSocket, bytes: RawData, binary: boolean) {
    try {
      if (binary) {
        socket.close(1003, 'Expected JSON');
        return;
      }
      const message = record(JSON.parse(bytes.toString()));
      if (message['type'] === 'cursor') {
        this.cursors.receive(socket, message);
        return;
      }
      if (this.queued >= 200) {
        socket.close(1013, 'Too many pending edits');
        return;
      }
      this.queued++;
      this.inbox.push({ socket, message });
      this.queue = this.queue.then(() => this.takeTurn());
    } catch {
      this.send(socket, { type: 'error', ...errorWire(undefined, 'studio.collab.invalidMessage') });
    }
  }
  private async takeTurn() {
    const next = this.inbox.shift();
    if (next === undefined) {
      return;
    }
    const batch = this.alone > 0 ? [next] : [next, ...this.following(next)];
    this.alone = Math.max(0, this.alone - 1);
    if (batch.length > 1 && (await this.coordinator.run(() => this.handleTogether(batch)))) {
      this.inbox.splice(0, batch.length - 1);
      this.queued -= batch.length;
      return;
    }
    if (batch.length > 1) {
      this.alone = batch.length - 1;
    }
    // One at a time, as each arrived: those behind keep their own turns.
    try {
      await this.coordinator.run(() => this.handle(next.socket, next.message));
    } catch (error) {
      this.send(next.socket, { type: 'error', ...errorWire(error, 'studio.collab.editFailed') });
    } finally {
      this.queued--;
    }
  }
  // The edits waiting right behind `first` from the same connection, with nothing else between them.
  private following(first: Incoming): readonly Incoming[] {
    const found: Incoming[] = [];
    for (const entry of this.inbox) {
      const same = entry.socket === first.socket && entry.message['epoch'] === first.message['epoch'];
      if (!same || entry.message['type'] !== 'update' || first.message['type'] !== 'update' || found.length >= BATCH_MAX - 1) {
        break;
      }
      found.push(entry);
    }
    return found;
  }
  /**
   * Edits that piled up while earlier ones were checked, judged as the one change they add up to: the check then reads
   * the page once, so a backlog cannot grow however large the page is. Only the document they end at is ever applied,
   * shared or saved, and it is checked like any single edit. False, with nothing changed, when they cannot be taken
   * together: each is then handled alone, with its own verdict. Only for a role the code check judges, and not for one
   * with editing options, whose undo steps through its edits one by one.
   */
  private async handleTogether(batch: readonly Incoming[]): Promise<boolean> {
    const [first] = batch;
    if (first === undefined || this.closed || first.message['epoch'] !== this.document.getMap('metadata').get('epoch')) {
      return false;
    }
    try {
      const role = await this.roleOf(first.socket);
      if (writesCode(role) || limitsEditing(role.editorOff)) {
        return false;
      }
      const saves = batch.map((entry) => parseSaveSequence(entry.message['save']));
      const updates = batch.map((entry) => Buffer.from(string(entry.message['update'], 2_000_000), 'base64'));
      const update = Buffer.from(Y.mergeUpdates(updates)).toString('base64');
      const before = Y.encodeStateVector(this.document);
      if (!(await this.applyUpdate({ ...first.message, update }, first.socket, role))) {
        return false;
      }
      this.publish(first.socket, first.message, before);
      for (const save of saves) {
        this.acknowledgeSave(first.socket, save, 'classify');
      }
      return true;
    } catch {
      return false;
    }
  }
  private detach(socket: WebSocket, key: string) {
    if (!this.clients.has(socket)) {
      return;
    }
    this.cursors.remove(socket);
    this.colors.release(key);
    this.clients.delete(socket);
    this.roles.delete(socket);
    this.people.delete(socket);
    this.presence();
  }
  private async handle(socket: WebSocket, message: Record<string, unknown>) {
    if (this.closed) {
      throw new Error('The shared branch changed. Reload Studio before editing.');
    }
    if (message['type'] === 'pong') {
      return;
    }
    if (message['type'] === 'presence') {
      this.select(socket, message);
      return;
    }
    if (message['type'] === 'take-selection') {
      this.takeSelection(socket, message);
      return;
    }
    if (message['type'] === 'sync-request') {
      this.synchronize(socket);
      return;
    }
    if (message['epoch'] !== this.document.getMap('metadata').get('epoch')) {
      throw new Error('The draft was reset. Reload the studio before editing.');
    }
    const save = parseSaveSequence(message['save']);
    // Edits are checked against the sender's role here, not only in its browser:
    // a client that skips its own Client-mode check is still refused.
    const role = await this.roleOf(socket);
    const before = Y.encodeStateVector(this.document);
    const previous = this.text.toString();
    if (message['type'] === 'update') {
      if (!(await this.applyUpdate(message, socket, role))) {
        // A replay can already exist in memory after a failed disk or durable write.
        // CRDT deduplication proves convergence, not persistence.
        if (this.text.toString() !== this.saved) {
          this.broadcast({
            type: 'update',
            update: Buffer.from(Y.encodeStateAsUpdate(this.document)).toString('base64'),
            revision: this.revision,
            writePending: true,
          });
        }
        this.acknowledgeSave(socket, save, 'immediate');
        return;
      }
    } else if (message['type'] === 'action') {
      await this.applyAction(socket, message, role);
    } else {
      throw new Error('Unknown collaboration message');
    }
    this.rememberChange(socket, role, previous);
    this.publish(socket, message, before);
    // Peers consume the accepted CRDT delta immediately. File projection and
    // durable storage must not sit between a keystroke and another editor.
    this.acknowledgeSave(socket, save, message['type'] === 'update' ? 'classify' : 'immediate');
  }
  // What everyone gets once the document has changed.
  private publish(socket: WebSocket, message: Record<string, unknown>, before: Uint8Array) {
    this.revision++;
    const update = Buffer.from(Y.encodeStateAsUpdate(this.document, before)).toString('base64');
    for (const client of this.clients.keys()) {
      this.send(client, {
        type: 'update',
        update,
        revision: this.revision,
        writePending: true,
        ownAction: client === socket && message['type'] === 'action',
        structural: message['type'] === 'action',
        selection: this.clients.get(client)?.selection ?? '',
        selectionRequest: this.clients.get(client)?.selectionRequest ?? 0,
        occurrence: this.clients.get(client)?.occurrence ?? 0,
      });
    }
    this.presence();
  }
  private rememberChange(socket: WebSocket, role: RoleView, previous: string) {
    const person = this.people.get(socket);
    const next = this.text.toString();
    if (person !== undefined && next !== previous && limitsEditing(role.editorOff)) {
      this.editorUndo.record(person, role, { current: previous, next });
    }
  }
  private acknowledgeSave(socket: WebSocket, save: number | undefined, scheduling: SourceSnapshot['scheduling']) {
    const revision = this.revision;
    void this.durable.save(this.snapshot(scheduling), scheduling === 'immediate').then(
      () => this.send(socket, { type: 'saved', revision, save }),
      () =>
        this.broadcast({
          type: 'error',
          ...errorWire(undefined, 'studio.collab.draftFailed'),
        }),
    );
  }
  private async roleOf(socket: WebSocket): Promise<RoleView> {
    const resolve = this.roles.get(socket);
    if (resolve === undefined) {
      throw new Error('This connection has closed. Reconnect before editing.');
    }
    const role = await resolve();
    assert(role.id.length > 0, 'A connection edits as a named role');
    return role;
  }
  private async applyAction(socket: WebSocket, message: Record<string, unknown>, role: RoleView) {
    if (message['checksum'] !== checksum(this.text.toString())) {
      throw new Error('Another edit arrived. Please repeat the drag or action.');
    }
    const action = parseAction(message['action']);
    assertDocumentActionAllowed(role, this.file, this.text.toString(), action);
    const client = this.clients.get(socket);
    const owner = selectionOwner(this.clients.values(), client?.id ?? '', this.file, 'node' in action ? action.node : '');
    if (owner) {
      throw new ReferencedError('studio.collab.selectionLocked', { name: owner.name });
    }
    const settings = action.kind === 'insert' ? await loadInsertionDefaults(this.root) : undefined;
    if (message['checksum'] !== checksum(this.text.toString())) {
      throw new Error('The page changed while loading defaults. Repeat the insertion.');
    }
    // A configured import path only resolves with the project's settings, so the insert is checked again here, before any edit.
    assertComponentInsertAllowed(role, this.file, action, settings?.imports ?? []);
    const edits =
      action.kind === 'paste' ? pasteEdits(this.text.toString(), this.file, action) : structuralEdits(this.text.toString(), action, this.file, settings);
    // A paste carries markup and frontmatter from the browser; every other action only arranges what the server holds.
    if (action.kind === 'paste') {
      await this.assertCode(role, applyEdits(this.text.toString(), [...edits]));
    }
    const source = this.text.toString();
    this.guard.note(role, this.file, source);
    const result = applyEdits(source, edits);
    // The action was allowed by its shape; its result is checked too, so an
    // operation that reaches past what the action named is still refused.
    if (result !== source) {
      assertDocumentChangeAllowed(role, this.file, source, result);
    }
    const select = actionSelection(source, result, edits, action);
    this.document.transact(() => {
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        this.text.delete(edit.start, edit.end - edit.start);
        this.text.insert(edit.start, edit.text);
      }
    }, 'structure');
    if (action.kind === 'insert') {
      this.sayLeftOut(socket, leftOutAssets(resolveImport(this.file, action.importPath, settings?.imports ?? []), settings));
    }
    for (const [connection, peer] of this.clients) {
      this.clients.set(connection, {
        ...peer,
        selection: select(peer.selection, connection === socket),
        occurrence: connection === socket ? 0 : peer.occurrence,
        ...(connection === socket ? { editing: false } : {}),
      });
    }
  }
  // The insert happened; the person is told which default file it went without.
  private sayLeftOut(socket: WebSocket, files: readonly string[]) {
    const [file] = files;
    if (file !== undefined) {
      this.send(socket, {
        type: 'notice',
        ...errorWire(new ReferencedError('componentProps.defaults.insertedWithoutAsset', { file }), 'studio.collab.editFailed'),
      });
    }
  }
  private select(socket: WebSocket, message: Record<string, unknown>) {
    const client = this.clients.get(socket);
    if (!client) {
      return;
    }
    const selection = string(message['selection'] ?? '', 500);
    const owner = selectionOwner(this.clients.values(), client.id, this.file, selection);
    const next = {
      ...client,
      name: client.githubId ? client.name : string(message['name'], 50),
      selection,
      selectionRequest: selectionRequest(message['selectionRequest']),
      editing: !owner,
      page: sourcePath(string(message['page'] ?? this.file, 500)),
      occurrence: occurrenceOf(message['occurrence']),
      updatedAt: Date.now(),
    };
    this.clients.set(socket, next);
    this.send(socket, {
      type: 'selection',
      selection: next.selection,
      selectionRequest: next.selectionRequest,
      occurrence: next.occurrence,
      ...(owner
        ? {
            owner,
            requested: selection,
            page: sourcePath(string(message['page'] ?? this.file, 500)),
            requestedOccurrence: occurrenceOf(message['occurrence']),
          }
        : {}),
    });
    this.presence();
  }
  private takeSelection(socket: WebSocket, message: Record<string, unknown>) {
    const client = this.clients.get(socket);
    if (!client) {
      return;
    }
    const selection = string(message['selection'], 500);
    const ownerId = string(message['owner'], 100);
    const page = sourcePath(string(message['page'] ?? this.file, 500));
    const occurrence = occurrenceOf(message['occurrence']);
    const owner = selectionOwner(this.clients.values(), client.id, this.file, selection);
    const ownerSocket = [...this.clients].find(([, peer]) => peer.id === ownerId)?.[0];
    if (!owner || owner.id !== ownerId || !ownerSocket) {
      throw new Error('This selection has changed. Select the element again.');
    }
    this.clients.set(ownerSocket, {
      ...owner,
      editing: false,
      updatedAt: Date.now(),
    });
    this.clients.set(socket, {
      ...client,
      selection,
      selectionRequest: selectionRequest(message['selectionRequest']),
      editing: true,
      page,
      occurrence,
      updatedAt: Date.now(),
    });
    this.send(ownerSocket, {
      type: 'selection',
      selection: owner.selection,
      selectionRequest: owner.selectionRequest ?? 0,
      occurrence: owner.occurrence,
    });
    this.send(socket, {
      type: 'selection',
      selection,
      occurrence,
      selectionRequest: selectionRequest(message['selectionRequest']),
    });
    this.presence();
  }
  private synchronize(socket: WebSocket) {
    this.send(socket, {
      type: 'sync',
      self: this.clients.get(socket)?.id,
      epoch: this.document.getMap('metadata').get('epoch'),
      update: Buffer.from(Y.encodeStateAsUpdate(this.document)).toString('base64'),
      revision: this.revision,
    });
    if (this.live?.publishing) {
      this.send(socket, { type: 'publishing', state: this.live.publishing() });
    }
    for (const packet of this.live?.snapshot() ?? this.cursors.snapshot()) {
      this.send(socket, { type: 'cursor', ...packet });
    }
  }
  async diskChanged() {
    if (this.closed) {
      return;
    }
    await this.coordinator
      .run(async () => {
        if (this.closed) {
          return;
        }
        const source = await readSource(this.root, this.file);
        if (source !== this.saved) {
          await this.setSource(source);
        }
      })
      .catch((error: unknown) => this.broadcast({ type: 'error', message: String(error) }));
  }
  // An edit that arrives as text is also judged by what it changes: no new code without a code permission, and a
  // limited role's editing options. The room handles one message at a time, so the document it was probed against
  // must still be the document it applies to.
  private async assertContent(socket: WebSocket, role: RoleView, after: string) {
    const before = this.text.toString();
    if (after === before) {
      return;
    }
    await this.assertCode(role, after);
    if (limitsEditing(role.editorOff) && !this.editorUndo.steps(this.people.get(socket) ?? '', role, { current: before, next: after })) {
      await assertEditorContentAllowed(role, this.file, { before, after }, (file) => readSource(this.root, file).catch(() => undefined));
    }
    if (this.text.toString() !== before) {
      throw new Error('Another edit arrived. Please repeat the edit.');
    }
  }
  private async assertCode(role: RoleView, after: string) {
    const before = this.text.toString();
    await this.guard.assertAllowed(role, { file: this.file, before, after });
    if (this.text.toString() !== before) {
      throw new Error('Another edit arrived. Please repeat the edit.');
    }
  }
  private validateUpdate(message: Record<string, unknown>, socket: WebSocket, role: RoleView) {
    const update = Buffer.from(string(message['update'], 2_000_000), 'base64');
    const probe = new Y.Doc();
    try {
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.document));
      Y.applyUpdate(probe, update);
      const client = this.clients.get(socket);
      const owner = selectionOwner(this.clients.values(), client?.id ?? '', this.file, client?.selection ?? '');
      if (owner && probe.getText('source').toString() !== this.text.toString()) {
        throw new ReferencedError('studio.collab.selectionLocked', { name: owner.name });
      }
      if (probe.getMap('metadata').get('epoch') !== this.document.getMap('metadata').get('epoch')) {
        throw new Error('Invalid document identity');
      }
      if (probe.getText('source').length > MAX_SOURCE || Y.encodeStateAsUpdate(probe).length > 8_000_000) {
        throw new Error('Document exceeds collaboration limits');
      }
      // An update that waits for a change the room does not hold would apply later, judged under whoever sends that
      // change. A role without code permission may only send what can be judged now.
      if (!writesCode(role) && waiting(probe) !== waiting(this.document)) {
        throw new Error('Another edit arrived. Please repeat the edit.');
      }
      const after = probe.getText('source').toString();
      if (after !== this.text.toString()) {
        assertDocumentChangeAllowed(role, this.file, this.text.toString(), after);
      }
      return { update, after };
    } finally {
      probe.destroy();
    }
  }
  private async applyUpdate(message: Record<string, unknown>, socket: WebSocket, role: RoleView) {
    const { update, after } = this.validateUpdate(message, socket, role);
    await this.assertContent(socket, role, after);
    const restoreSelections = captureSelectionPositions(this.document, this.clients.values());
    let changed = false;
    const markChanged = () => {
      changed = true;
    };
    this.document.on('update', markChanged);
    try {
      Y.applyUpdate(this.document, update, socket);
    } finally {
      this.document.off('update', markChanged);
    }
    if (changed) {
      restoreSelections(this.clients);
    }
    return changed;
  }
  private replace(source: string, origin: string) {
    const edit = textChange(this.text.toString(), source);
    this.document.transact(() => {
      this.text.delete(edit.start, edit.remove);
      this.text.insert(edit.start, edit.insert);
    }, origin);
  }
  async persist() {
    await this.durable.save(this.snapshot('immediate'), true);
  }
  private snapshot(scheduling: SourceSnapshot['scheduling']): SourceSnapshot {
    return {
      source: this.text.toString(),
      bytes: Y.encodeStateAsUpdate(this.document),
      scheduling,
    };
  }
  private async writeSnapshot(snapshot: SourceSnapshot) {
    assert(snapshot.source.length <= MAX_SOURCE, 'Projected source stays within the source limit');
    assert(snapshot.bytes.length <= 8_000_000, 'Projected document stays within the draft limit');
    const changed = await this.writeSource(snapshot.source, snapshot.scheduling);
    await this.storage.write(this.file, snapshot.bytes);
    if (changed) {
      this.broadcast({
        type: 'source-written',
        structural: snapshot.scheduling === 'immediate',
      });
    }
  }
  private async writeSource(source: string, scheduling: SourceSnapshot['scheduling']) {
    if (source === this.saved) {
      return false;
    }
    const absolute = await preparePath(this.root, this.file);
    await writeFile(absolute + '.studio-tmp', source);
    await rename(absolute + '.studio-tmp', absolute);
    const mode = scheduling === 'classify' ? sourceRenderMode(this.file, this.saved, source) : 'immediate';
    this.saved = source;
    this.live?.written?.(this.file, mode);
    return true;
  }
  async setSource(source: string) {
    if (source === this.text.toString()) {
      return;
    }
    const vector = Y.encodeStateVector(this.document);
    const restore = captureSelectionPositions(this.document, this.clients.values());
    this.replace(source, 'external');
    restore(this.clients);
    for (const [socket, peer] of this.clients) {
      this.send(socket, {
        type: 'selection',
        selection: peer.selection,
        selectionRequest: peer.selectionRequest ?? 0,
        occurrence: peer.occurrence,
      });
    }
    this.presence();
    await this.persist();
    this.broadcast({
      type: 'update',
      update: Buffer.from(Y.encodeStateAsUpdate(this.document, vector)).toString('base64'),
      revision: ++this.revision,
    });
  }
  private presence() {
    releaseSelectionOwners(this.clients);
    if (this.publishPresence) {
      this.publishPresence();
    } else {
      this.broadcast({ type: 'presence', peers: [...this.clients.values()] });
    }
  }
  private send(socket: WebSocket, message: unknown) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
  closeWorkspace() {
    this.closed = true;
    this.broadcast({ type: 'project-changed' });
    for (const socket of this.clients.keys()) {
      socket.close(1000, 'Shared branch changed');
    }
    this.document.destroy();
  }
  broadcast(message: unknown) {
    for (const client of this.clients.keys()) {
      this.send(client, message);
    }
  }
  broadcastCursor(packet: CursorPacket) {
    for (const socket of this.clients.keys()) {
      if (socket.bufferedAmount < 64000) {
        this.send(socket, { type: 'cursor', ...packet });
      }
    }
  }
}
// The changes a document holds back until others arrive, as one comparable value.
function waiting(document: Y.Doc): string {
  const { pendingStructs, pendingDs } = document.store;
  return JSON.stringify([pendingStructs === null ? '' : Buffer.from(pendingStructs.update).toString('base64'), pendingDs?.length ?? 0]);
}
export function checksum(source: string) {
  return createHash('sha256').update(source).digest('hex');
}

const RELEASE_LISTENERS_MAX = 16;

export function createRooms(root: string) {
  const coordinator = new SerialQueue(() => verifyGitWorkspaceLease(root));
  const rooms = new Map<string, Promise<Room>>();
  const readyRooms = new Set<Room>();
  let publishing: PublishState = { kind: 'idle' };
  const sourceListeners = new Set<(file: string, mode: SourceRenderMode) => void>();
  const releaseListeners = new Set<() => void>();
  const live = { ...livePresence(readyRooms, sourceListeners), publishing: () => publishing };
  // Reads a room's own text, so code typed a moment ago counts as the project's before it reaches the disk.
  const guard = new CodeGuard(root, async (file) => (await rooms.get(file))?.text.toString() ?? readSource(root, file));
  const broadcast = (message: unknown) => {
    for (const room of readyRooms) {
      room.broadcast(message);
    }
  };
  const presence = () => {
    const peers = [...readyRooms].flatMap((room) => [...room.clients.values()]);
    for (const room of readyRooms) {
      room.broadcast({ type: 'presence', peers });
    }
  };
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_000_000, clientTracking: true });
  const get = (input: string) => {
    const file = sourcePath(input);
    let pending = rooms.get(file);
    if (!pending) {
      if (rooms.size >= 100) {
        throw new Error('Too many open documents');
      }
      const room = new Room(root, file, coordinator, presence, live, guard);
      pending = room.initialize().then(() => {
        readyRooms.add(room);
        return room;
      });
      rooms.set(file, pending);
      pending.catch(() => rooms.delete(file));
    }
    return pending;
  };
  return {
    onWrite: (listener: (file: string, mode: SourceRenderMode) => void) => {
      sourceListeners.add(listener);
      return () => sourceListeners.delete(listener);
    },
    publishing: (state: PublishState) => {
      publishing = state;
      broadcast({ type: 'publishing', state });
    },
    hasClients: () => [...readyRooms].some((room) => room.clients.size > 0),
    projectChanged: () => broadcast({ type: 'project-changed' }),
    resetWorkspace: () => resetWorkspaceRooms(rooms, readyRooms),
    coordinator,
    guard,
    // Call under the coordinator before filesystem snapshots or multi-file writes.
    // Await actual saves, because flushing a failed batch alone does not retry it.
    persist: async () => {
      await Promise.all([...readyRooms].map((room) => room.persist()));
    },
    sockets,
    get,
    onRelease: (listener: () => void) => {
      assert(releaseListeners.size < RELEASE_LISTENERS_MAX, 'Release listeners stay bounded');
      releaseListeners.add(listener);
    },
    release: () => releaseRooms(sockets, releaseListeners),
    read: async (file: string) => {
      const pending = rooms.get(file);
      return pending ? (await pending).text.toString() : readSource(root, file);
    },
    remove: (file: string) => removeRoom(root, rooms, readyRooms, file),
    changed: async (file: string) => {
      const room = rooms.get(file);
      if (room) {
        await (await room).diskChanged();
      }
    },
  };
}
function livePresence(rooms: ReadonlySet<Room>, sourceListeners: ReadonlySet<(file: string, mode: SourceRenderMode) => void>): LivePresence {
  return {
    written: (file, mode) => {
      for (const listener of sourceListeners) {
        listener(file, mode);
      }
    },
    colors: new PresenceColors(),
    broadcast: (packet) => {
      for (const room of rooms) {
        room.broadcastCursor(packet);
      }
    },
    snapshot: () => [...rooms].flatMap((room) => [...room.cursors.snapshot()]),
  };
}

// A dev server closed. Its restart serves these same rooms (server/integration.ts), so only what belongs to that
// server's connections is let go. The WebSocketServer stays open: a closed one refuses every later
// connection, and nothing can reopen it.
function releaseRooms(sockets: WebSocketServer, listeners: ReadonlySet<() => void>) {
  for (const client of sockets.clients) {
    // 1012 is "service restart": the browser reconnects.
    client.close(1012, 'Studio server restarted');
  }
  for (const listener of listeners) {
    listener();
  }
}

async function removeRoom(root: string, rooms: Map<string, Promise<Room>>, readyRooms: Set<Room>, file: string) {
  const pending = rooms.get(file);
  if (pending) {
    await (await pending).durable.flush();
  }
  await new DraftStorage(root).remove(file);
  if (pending) {
    const room = await pending;
    room.broadcast({
      type: 'error',
      ...errorWire(undefined, 'studio.collab.fileRemoved'),
    });
    for (const client of room.clients.keys()) {
      client.close(1000, 'File removed');
    }
    readyRooms.delete(room);
    room.document.destroy();
    rooms.delete(file);
  }
}

async function resetWorkspaceRooms(rooms: Map<string, Promise<Room>>, readyRooms: Set<Room>) {
  for (const pending of rooms.values()) {
    const room = await pending;
    room.closeWorkspace();
  }
  readyRooms.clear();
  rooms.clear();
}
