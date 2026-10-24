import { EditorHistory } from './editorHistory';
import { SelectionIntent } from './selectionIntent';
import { watchConnection } from './connectionWatch';
import { SaveWatch } from './saveWatch';
import { parseSaveSequence } from './saveProtocol';
import { receiveSharedPublish } from '../publishing/sharedPublish';
import { getEditorRole, subscribeRole } from '../roles/roleStore';
import { assertClientAction, assertClientSourceChange } from '../roles/clientPolicy';
import { occurrenceOf, parsePeer, type Peer } from './presence';
import { selectionOwner, selectionLockedMessage } from './selectionLock';
import { CursorChannel, participantId } from './cursorChannel';
import { ActionableNotice } from '../notifications/notice';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useEffect, useState } from 'react';
import { record, string, textChange } from '../../shared/validation';
import type { Edit, TreeAction } from '../source/source';

export const LOCAL = Symbol('local');
const STRUCTURE = Symbol('structure');
export class SharedDocument {
  readonly cursors = new CursorChannel((message) => this.send(message));
  private readonly participant = participantId();
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText('source');
  readonly undo = new Y.UndoManager(this.text, {
    trackedOrigins: new Set([LOCAL, STRUCTURE]),
    captureTimeout: 400,
  });
  readonly history = new EditorHistory(this.undo);
  private readonly stopRoleCapture = subscribeRole(() => this.undo.stopCapturing());
  recordCommand = this.history.record.bind(this.history);
  revision = 0;
  peers: Peer[] = [];
  selfId = '';
  selected = '';
  selectedOccurrence = 0;
  private page = '';
  private occurrence = 0;
  status = 'Connecting';
  error = '';
  get selectionNotice(): ActionableNotice | undefined {
    const owner = selectionOwner(this.peers, this.selfId, this.file, this.selected);
    return owner
      ? this.lockNotice(owner, this.selected, this.page || this.file, this.selectedOccurrence)
      : undefined;
  }
  ready = false;
  private socket: WebSocket | undefined;
  private closed = false;
  private suspended = false;
  private attempts = 0;
  private synchronized = false;
  private saveRecoveries = 0;
  private readonly saves = new SaveWatch(() => this.recoverSave());
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopWatching?: () => void;
  private readonly listeners = new Set<() => void>();
  private selection = '';
  private readonly selectionIntent = new SelectionIntent();
  private epoch = '';
  private readonly persistence: IndexeddbPersistence;
  private readonly name =
    sessionStorage.getItem('studio-name') ?? `Editor ${Math.floor(Math.random() * 900 + 100)}`;
  constructor(readonly file: string) {
    this.persistence = new IndexeddbPersistence(
      'astro-studio:' + location.origin + ':' + file,
      this.doc,
    );
    sessionStorage.setItem('studio-name', this.name);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.revision++;
      if (origin === LOCAL || origin === this.undo) {
        this.status =
          this.socket?.readyState === WebSocket.OPEN ? 'Saving' : 'Offline · edits pending';
        this.send({ type: 'update', epoch: this.epoch, update: encode(update) });
      }
      this.emit();
    });
    void this.persistence.whenSynced
      .then(() => {
        const epoch: unknown = this.doc.getMap('metadata').get('epoch');
        if (typeof epoch === 'string') {
          this.epoch = epoch;
        }
        this.connect();
      })
      .catch((error: unknown) => {
        this.error = 'Offline storage unavailable: ' + String(error);
        this.connect();
      });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  private connect() {
    if (this.closed || this.suspended) {
      return;
    }
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/studio/sync?file=${encodeURIComponent(this.file)}&participant=${this.participant}`,
    );
    this.socket = socket;
    this.synchronized = false;
    this.stopWatching?.();
    this.stopWatching = watchConnection(socket, () => {
      if (this.socket !== socket || this.closed || this.suspended) {
        return;
      }
      this.restartConnection();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket && !this.closed) {
        this.receive(event);
      }
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket || this.closed) {
        return;
      }
      this.cursors.reset();
      this.synchronized = false;
      this.saves.reset();
      if (event.code === 4001) {
        this.status = 'Sign-in required';
        this.error =
          'Your session expired or repository access changed. Your local edits are preserved. Sign in again.';
        this.emit();
        return;
      }
      this.status = this.suspended
        ? this.status
        : navigator.onLine
          ? 'Reconnecting…'
          : 'Offline · edits pending';
      this.selected = '';
      this.emit();
      if (!this.closed && !this.suspended) {
        const delay = Math.min(60_000, 500 * 2 ** Math.min(this.attempts++, 6));
        this.reconnect = setTimeout(() => this.connect(), delay + Math.random() * 500);
      }
    });
  }
  private restartConnection() {
    this.disconnectConnection();
    this.status = 'Reconnecting…';
    this.emit();
    this.connect();
  }
  private disconnectConnection() {
    this.stopWatching?.();
    this.saves.reset();
    clearTimeout(this.reconnect);
    // A broken proxy need not finish its close handshake before we reconnect.
    const socket = this.socket;
    this.socket = undefined;
    this.synchronized = false;
    socket?.close();
    this.cursors.reset();
  }
  private recoverSave() {
    if (this.closed || this.suspended) {
      return;
    }
    if (this.saveRecoveries < 3) {
      this.saveRecoveries++;
      this.restartConnection();
    } else {
      this.disconnectConnection();
      this.status = 'Needs attention';
      this.error =
        'Save confirmation did not arrive. Your local edits are preserved. Reload Studio to retry.';
      this.emit();
    }
  }
  private receive(event: MessageEvent) {
    try {
      const message = record(JSON.parse(string(event.data, 12_000_000)));
      if (this.cursors.receive(message)) {
        return;
      }
      if (message['type'] === 'project-changed') {
        window.dispatchEvent(new CustomEvent('studio:project-changed'));
        return;
      }
      if (message['type'] === 'publishing') {
        receiveSharedPublish(message['state']);
        return;
      }
      if (message['type'] === 'ping') {
        this.send({ type: 'pong' });
        return;
      }
      if (message['type'] === 'sync' || message['type'] === 'update') {
        if (message['type'] === 'sync') {
          const epoch = string(message['epoch'], 100);
          if (this.epoch && this.epoch !== epoch) {
            this.error =
              'The server draft was replaced. This browser still has the previous draft; export its source before clearing this site’s stored data.';
            this.ready = false;
            this.emit();
            return;
          }
          this.epoch = epoch;
          this.selfId = string(message['self'] ?? '', 100);
          this.peers = [];
        }
        const shouldReplay = this.ready || this.doc.getMap('metadata').has('epoch');
        this.applyServerUpdate(message);
        if (message['type'] === 'sync') {
          this.attempts = 0;
          this.saves.reset();
          this.synchronized = true;
          this.ready = true;
          this.status = shouldReplay ? 'Saving' : 'Saved';
          if (shouldReplay) {
            this.send({
              type: 'update',
              epoch: this.epoch,
              update: encode(Y.encodeStateAsUpdate(this.doc)),
            });
          }
          this.select(this.selection, this.page || this.file, this.occurrence);
        }
        notifySourceUpdated(message);
      } else if (message['type'] === 'saved') {
        this.receiveSaved(parseSaveSequence(message['save']));
      } else if (message['type'] === 'selection') {
        this.receiveSelection(message);
      } else if (message['type'] === 'error') {
        this.error = string(message['message']);
        this.status = 'Needs attention';
      } else if (message['type'] === 'presence' && Array.isArray(message['peers'])) {
        this.peers = message['peers']
          .slice(0, 3000)
          .map((peer: unknown) => parsePeer(peer, this.file));
      }
      this.emit();
    } catch (error) {
      this.error = String(error);
      this.emit();
    }
  }
  private receiveSaved(sequence: number | undefined) {
    if (!this.saves.saved(sequence)) {
      return;
    }
    this.status = this.saves.pending ? 'Saving' : 'Saved';
    if (!this.saves.pending) {
      this.saveRecoveries = 0;
      this.error = '';
    }
  }
  private applyServerUpdate(message: Record<string, unknown>) {
    const ownAction = message['ownAction'] === true;
    if (ownAction) {
      this.undo.stopCapturing();
    }
    Y.applyUpdate(
      this.doc,
      decode(string(message['update'], 12_000_000)),
      ownAction ? STRUCTURE : 'remote',
    );
    if (ownAction) {
      this.undo.stopCapturing();
    }
    if (typeof message['selection'] === 'string') {
      this.receiveSelection(message);
    }
  }
  private receiveSelection(message: Record<string, unknown>) {
    if (!this.selectionIntent.accepts(message['selectionRequest'])) {
      return;
    }
    this.selection = this.selected = string(message['selection'], 500);
    this.selectedOccurrence = occurrenceOf(message['occurrence']);
    this.error = typeof message['message'] === 'string' ? message['message'] : '';
  }
  select(selection: string, page = this.file, occurrence = 0) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.page = page;
    this.occurrence = occurrence;
    this.selection = this.selected = selection;
    this.selectedOccurrence = occurrence;
    this.send({
      type: 'presence',
      name: this.name,
      selection,
      page,
      occurrence,
      selectionRequest: this.selectionIntent.next(),
    });
    this.emit();
    return true;
  }
  canEdit(selection: string) {
    return !selectionOwner(this.peers, this.selfId, this.file, selection);
  }
  private lockNotice(owner: Peer, selection: string, page: string, occurrence: number) {
    return new ActionableNotice(selectionLockedMessage(owner), {
      person: { id: owner.githubId, name: owner.name },
      action: {
        label: 'Take over',
        run: () => {
          if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('The session changed. Select the element again.');
          }
          this.page = page;
          this.occurrence = occurrence;
          this.send({
            type: 'take-selection',
            owner: owner.id,
            selection,
            page,
            occurrence,
            selectionRequest: this.selectionIntent.next(),
          });
        },
      },
    });
  }
  whenSaved(): Promise<void> {
    if (this.status === 'Saved') {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('The save did not finish.'));
      }, 15000);
      const off = this.subscribe(() => {
        if (this.status === 'Saved') {
          clearTimeout(timer);
          off();
          resolve();
        }
        if (this.error) {
          clearTimeout(timer);
          off();
          reject(new Error(this.error));
        }
      });
    });
  }
  replaceSource(source: string) {
    const change = textChange(this.text.toString(), source);
    this.edit({ start: change.start, end: change.start + change.remove, text: change.insert });
  }
  edit(edit: Edit) {
    if (!this.ready || !this.canEdit(this.selection)) {
      return;
    }
    if (getEditorRole() === 'client') {
      const source = this.text.toString();
      assertClientSourceChange(
        this.file,
        source,
        source.slice(0, edit.start) + edit.text + source.slice(edit.end),
      );
    }
    const previous = this.text.toString().slice(edit.start, edit.end);
    const minimal = textChange(previous, edit.text);
    this.doc.transact(() => {
      this.text.delete(edit.start + minimal.start, minimal.remove);
      this.text.insert(edit.start + minimal.start, minimal.insert);
    }, LOCAL);
  }
  async action(action: TreeAction) {
    if (getEditorRole() === 'client') {
      if (!this.file.startsWith('src/pages/')) {
        throw new Error('Component source is protected in Client mode.');
      }
      assertClientAction(this.text.toString(), action);
    }
    if ('node' in action && !this.canEdit(action.node)) {
      return;
    }
    if (!this.synchronized || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Reconnect before rearranging the page');
    }
    const source = this.text.toString();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    if (source !== this.text.toString()) {
      throw new Error('The page changed; repeat the action');
    }
    const checksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    this.send({ type: 'action', epoch: this.epoch, checksum, action });
  }
  private send(data: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (
        data &&
        typeof data === 'object' &&
        'type' in data &&
        data.type === 'cursor' &&
        this.socket.bufferedAmount > 64000
      ) {
        return;
      }
      if (
        data &&
        typeof data === 'object' &&
        'type' in data &&
        (data.type === 'update' || data.type === 'action')
      ) {
        // The sync handshake replays the complete local document, including edits
        // made while the new socket was open but had not received its epoch yet.
        if (!this.synchronized) {
          return;
        }
        const save = this.saves.sent();
        if (save === undefined) {
          this.recoverSave();
          return;
        }
        this.status = 'Saving';
        this.socket.send(JSON.stringify({ ...data, save }));
        return;
      }
      this.socket.send(JSON.stringify(data));
    }
  }
  suspend(suspended: boolean) {
    if (this.suspended === suspended) {
      return;
    }
    this.suspended = suspended;
    clearTimeout(this.reconnect);
    if (suspended) {
      this.stopWatching?.();
      this.saves.reset();
      this.socket?.close();
    } else {
      this.connect();
    }
  }
  close() {
    this.cursors.reset();
    this.stopRoleCapture();
    this.closed = true;
    this.stopWatching?.();
    this.saves.reset();
    clearTimeout(this.reconnect);
    this.socket?.close();
    void this.persistence.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }
}
export function useDocument(file: string, active = true) {
  const [document, setDocument] = useState<SharedDocument>();
  const [, refresh] = useState(0);
  useEffect(() => {
    const document = new SharedDocument(file);
    setDocument(document);
    const unsubscribe = document.subscribe(() => refresh((value) => value + 1));
    return () => {
      unsubscribe();
      document.close();
    };
  }, [file]);
  useEffect(() => {
    document?.suspend(!active);
  }, [document, active]);
  // File sessions can change while the editor and preview stay mounted.
  // Never pair the previous document's source/actions with the new filename.
  return document?.file === file ? document : undefined;
}
function encode(bytes: Uint8Array) {
  let result = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(result);
}
function notifySourceUpdated(message: Readonly<Record<string, unknown>>): void {
  window.dispatchEvent(
    new CustomEvent('studio:source-updated', {
      detail:
        message['structural'] === true || message['ownAction'] === true ? 'structure' : undefined,
    }),
  );
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
