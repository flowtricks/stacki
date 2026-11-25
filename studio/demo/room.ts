// The other end of the client's collaboration socket: the same message protocol as
// the server's Room, for one person, in this page. Edits apply here, then the demo
// decides what the finished page can show. A room's document starts from a fixed
// seed, because the client's own cache holds CRDT ids from earlier visits, and a
// freshly numbered copy of the same text would double it on merge.
import * as Y from 'yjs';
import { assert } from '../vendor/stacki/shared/core/assert';
import { actionSelection } from '../src/features/navigator/actionSelection';
import { applyEdits, parseAction, type TreeAction } from '../src/features/source/source';
import { structuralEdits } from '../src/features/source/sourceOperations';
import type { InsertionDefaults } from '../src/features/source/instanceDefaults';
import { record, sourcePath, string, textChange } from '../src/shared/validation';
import { parseSaveSequence } from '../src/features/collaboration/saveProtocol';
import { isStyleOnlyChange } from './styleUpdates';

const SEED_CLIENT = 1;
const SAVE_DELAY_MS = 150;
const SELF = '00000000-0000-4000-8000-000000000000';

export interface RoomPeer {
  readonly deliver: (message: string) => void;
}

export interface RoomHost {
  readonly snapshotId: string;
  /** The file's baked text. */
  readonly baked: (file: string) => string | undefined;
  /** A short reason this action cannot be shown, or undefined when it can. */
  readonly refusal: (file: string, next: string) => string | undefined;
  readonly save: (file: string, update: Uint8Array) => void;
  readonly changed: (file: string) => void;
  readonly refused: (reason: string) => void;
  readonly selected: (file: string, source: string, selection: string) => void;
}

function encode(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(result);
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** The same bytes on every visit, so the client's cached ids stay valid. */
export function seedUpdate(source: string, snapshotId: string): Uint8Array {
  const seed = new Y.Doc();
  seed.clientID = SEED_CLIENT;
  seed.getMap('metadata').set('epoch', snapshotId);
  seed.getText('source').insert(0, source);
  const update = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return update;
}

/** Paste needs the clipboard's source file and a compiler this page does not carry. A
 * component insertion is planned like any other edit, and refused by `refusal` when
 * the bake has no template that renders it. */
function unavailableAction(action: TreeAction): string | undefined {
  return action.kind === 'paste' ? 'Paste is in the full Stacki app.' : undefined;
}

/** The recipes an insertion uses; undefined falls back to Studio's starter recipes. */
export type InsertionSource = () => InsertionDefaults | undefined;

export class DemoRoom {
  readonly document = new Y.Doc();
  readonly text = this.document.getText('source');
  private peer: RoomPeer | undefined;
  private selection = '';
  private page: string;
  private occurrence = 0;
  private selectionRequest = 0;
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly file: string,
    private readonly host: RoomHost,
    source: string,
    saved: Uint8Array | undefined,
    textChanged: (file: string, text: string) => void = () => undefined,
    private readonly insertion: InsertionSource = () => undefined,
  ) {
    this.page = file;
    Y.applyUpdate(this.document, seedUpdate(source, host.snapshotId));
    if (saved !== undefined) {
      Y.applyUpdate(this.document, saved);
    }
    // Every change, the moment it lands, before the save delay: a style scrub previews
    // from here on each tick, the way Vite's CSS update does, and commits once it rests.
    this.text.observe(() => textChanged(this.file, this.text.toString()));
  }

  attach(peer: RoomPeer): { readonly receive: (message: string) => void; readonly detach: () => void } {
    this.peer = peer;
    this.send({
      type: 'sync',
      self: SELF,
      epoch: this.host.snapshotId,
      update: encode(Y.encodeStateAsUpdate(this.document)),
      revision: this.revision,
    });
    this.sendPresence();
    return {
      receive: (message) => this.receive(message),
      detach: () => {
        if (this.peer === peer) {
          this.peer = undefined;
        }
      },
    };
  }

  private send(message: unknown): void {
    this.peer?.deliver(JSON.stringify(message));
  }

  private sendPresence(): void {
    const self = {
      id: SELF,
      name: 'You',
      selection: this.selection,
      file: this.file,
      page: this.page,
      occurrence: this.occurrence,
      updatedAt: Date.now(),
      color: 0,
    };
    this.send({ type: 'presence', peers: [self] });
  }

  // Errors reach the client as the server's would: a message, not a dropped socket.
  private receive(text: string): void {
    try {
      this.handle(record(JSON.parse(text)));
    } catch (error: unknown) {
      this.send({ type: 'error', message: error instanceof Error ? error.message : 'Edit failed' });
    }
  }

  private handle(message: Record<string, unknown>): void {
    switch (message['type']) {
      case 'presence':
        this.select(message);
        return;
      case 'sync-request':
        this.send({ type: 'sync', self: SELF, epoch: this.host.snapshotId, update: encode(Y.encodeStateAsUpdate(this.document)), revision: this.revision });
        return;
      case 'update':
        this.applyUpdate(message);
        return;
      case 'action':
        this.applyAction(message);
        return;
      default:
        return; // Cursors and heartbeats need no second person to reach.
    }
  }

  private select(message: Record<string, unknown>): void {
    this.selection = string(message['selection'] ?? '', 500);
    this.page = sourcePath(string(message['page'] ?? this.file, 500));
    this.occurrence = typeof message['occurrence'] === 'number' ? message['occurrence'] : 0;
    this.selectionRequest = typeof message['selectionRequest'] === 'number' ? message['selectionRequest'] : 0;
    this.send({ type: 'selection', selection: this.selection, selectionRequest: this.selectionRequest, occurrence: this.occurrence });
    this.sendPresence();
    this.host.selected(this.file, this.text.toString(), this.selection);
  }

  private assertEpoch(message: Record<string, unknown>): void {
    if (message['epoch'] !== this.host.snapshotId) {
      throw new Error('The demo was reset. Reload the page before editing.');
    }
  }

  private applyUpdate(message: Record<string, unknown>): void {
    this.assertEpoch(message);
    const before = this.text.toString();
    Y.applyUpdate(this.document, decode(string(message['update'], 12_000_000)), 'client');
    this.revision++;
    this.send({ type: 'saved', revision: this.revision, save: parseSaveSequence(message['save']) });
    if (this.text.toString() !== before) {
      this.written('classify');
    }
  }

  private applyAction(message: Record<string, unknown>): void {
    this.assertEpoch(message);
    const action = parseAction(message['action']);
    const source = this.text.toString();
    const unavailable = unavailableAction(action);
    const edits = unavailable === undefined ? structuralEdits(source, action, this.file, action.kind === 'insert' ? this.insertion() : undefined) : [];
    const next = applyEdits(source, edits);
    const refusal = unavailable ?? this.host.refusal(this.file, next);
    if (refusal !== undefined) {
      this.host.refused(refusal);
      this.send({ type: 'saved', revision: this.revision, save: parseSaveSequence(message['save']) });
      return;
    }
    const select = actionSelection(source, next, edits, action);
    const vector = Y.encodeStateVector(this.document);
    this.document.transact(() => {
      for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
        this.text.delete(edit.start, edit.end - edit.start);
        this.text.insert(edit.start, edit.text);
      }
    }, 'structure');
    this.selection = select(this.selection, true);
    this.occurrence = 0;
    this.revision++;
    this.send({
      type: 'update',
      update: encode(Y.encodeStateAsUpdate(this.document, vector)),
      revision: this.revision,
      writePending: true,
      ownAction: true,
      structural: true,
      selection: this.selection,
      selectionRequest: this.selectionRequest,
      occurrence: 0,
    });
    this.sendPresence();
    this.send({ type: 'saved', revision: this.revision, save: parseSaveSequence(message['save']) });
    this.written('immediate');
  }

  /** The same notice the server sends once a write lands, so the canvas repaints. */
  private written(scheduling: 'classify' | 'immediate'): void {
    clearTimeout(this.timer);
    const flush = () => {
      this.host.save(this.file, Y.encodeStateAsUpdate(this.document));
      this.host.changed(this.file);
      this.send({ type: 'source-written', structural: scheduling === 'immediate' });
    };
    if (scheduling === 'immediate') {
      flush();
    } else {
      this.timer = setTimeout(flush, SAVE_DELAY_MS);
    }
  }

  /** The Style panel's write: a whole-file replace, as `/studio/api/source` does. A
   * scrub writes the file on every tick; when only its styles changed, the write is
   * saved once the ticks rest, and the canvas has already shown each tick. */
  setSource(source: string): void {
    const current = this.text.toString();
    if (source === current) {
      return;
    }
    const scheduling = isStyleOnlyChange(this.file, current, source) ? 'classify' : 'immediate';
    const vector = Y.encodeStateVector(this.document);
    const change = textChange(current, source);
    this.document.transact(() => {
      this.text.delete(change.start, change.remove);
      this.text.insert(change.start, change.insert);
    }, 'external');
    this.revision++;
    this.send({ type: 'update', update: encode(Y.encodeStateAsUpdate(this.document, vector)), revision: this.revision });
    this.written(scheduling);
  }
}

/** A listener for every text change in any room, as it lands. */
export type TextListener = (file: string, text: string) => void;

const TEXT_LISTENERS_MAX = 8;

export class DemoRooms {
  private readonly rooms = new Map<string, DemoRoom>();
  private readonly listeners = new Set<TextListener>();
  private insertion: InsertionSource = () => undefined;

  constructor(
    private readonly host: RoomHost,
    private readonly saved: ReadonlyMap<string, Uint8Array>,
  ) {
    for (const file of saved.keys()) {
      this.open(file);
    }
  }

  private open(file: string): DemoRoom | undefined {
    const known = this.rooms.get(file);
    if (known !== undefined) {
      return known;
    }
    const source = this.host.baked(file);
    if (source === undefined) {
      return undefined;
    }
    const room = new DemoRoom(
      file,
      this.host,
      source,
      this.saved.get(file),
      (changed, text) => {
        for (const listener of this.listeners) {
          listener(changed, text);
        }
      },
      () => this.insertion(),
    );
    this.rooms.set(file, room);
    return room;
  }

  /** Where insertions read their recipes: the project's, as the bake rendered them. */
  useInsertion(source: InsertionSource): void {
    this.insertion = source;
  }

  /** Hears every change as it lands, ahead of the save that follows it. */
  onText(listener: TextListener): () => void {
    assert(this.listeners.size < TEXT_LISTENERS_MAX, 'Text listeners stay few: each runs on every keystroke');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(input: string): DemoRoom {
    const file = sourcePath(input);
    const room = this.open(file);
    assert(room !== undefined, 'The client only opens files the project lists');
    return room;
  }

  /** The file as edited, or as baked when no one has opened it. */
  read(file: string): string | undefined {
    return this.rooms.get(file)?.text.toString() ?? this.host.baked(file);
  }

  edited(): ReadonlyMap<string, string> {
    const files = new Map<string, string>();
    for (const [file, room] of this.rooms) {
      const text = room.text.toString();
      if (text !== this.host.baked(file)) {
        files.set(file, text);
      }
    }
    return files;
  }
}
