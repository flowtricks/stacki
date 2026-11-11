// What the host serves into every app frame: the SDK at `stacki-sdk.js`, and the
// content security policy each app document runs under. Desktop's `stacki-app:`
// protocol (electron/handlers/appsHandlers.ts) and the Studio server
// (studio/src/features/apps/appsServer.ts) serve both from here, so an app sees
// the same SDK and the same sandbox in either editor.
//
// The SDK is generated from the RPC's own method table (appsRpc.ts): adding a
// method there adds its helper here, so the two cannot drift.
import { assert } from '../core/assert';
import { APP_API_VERSION, APP_METHOD_NAMES, APP_RPC_LIMITS } from './appsRpc';
import { APP_FORWARDED_KEYS, APP_RESERVED_SHORTCUTS } from './appShortcuts';

/** `stacki.selection.get()` and friends, from `selection.get` and the rest of the method table. */
function namespaces(): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = {};
  for (const method of APP_METHOD_NAMES) {
    const [group, name] = method.split('.');
    assert(group !== undefined, 'A method has a namespace');
    assert(name !== undefined, 'A method has a name');
    (grouped[group] ??= []).push(name);
  }
  return grouped;
}

/**
 * Helpers the SDK writes by hand over the generated ones, because they keep state
 * in the app's document: an override's handler, a custom frame's close, the
 * shortcuts an app keeps. Each still speaks only through `request`.
 */
const HAND_WRITTEN_HELPERS = {
  overrides: ['register', 'unregister'],
  ui: ['openFrame'],
  shortcuts: ['claim'],
  canvas: ['startInsertDrag'],
} as const;

/** The SDK's JavaScript: plain ES2019, no imports, defines `window.stacki`. */
export function appSdkSource(): string {
  const grouped = namespaces();
  for (const [group, names] of Object.entries(HAND_WRITTEN_HELPERS)) {
    assert(grouped[group] !== undefined, 'A hand-written helper joins a namespace the method table has');
    assert(names.length > 0, 'A hand-written group names its helpers');
  }
  const groups = JSON.stringify(grouped);
  const forwarded = JSON.stringify(APP_FORWARDED_KEYS);
  const reserved = JSON.stringify(APP_RESERVED_SHORTCUTS);
  const source = `/* Stacki app SDK, API version ${APP_API_VERSION}. Served by Stacki; see docs/apps.md. */
(function () {
  'use strict';
  if (window.stacki) { return; }
  var VERSION = ${APP_API_VERSION};
  var IN_FLIGHT_MAX = ${APP_RPC_LIMITS.requestsInFlightMax};
  var FORWARDED = ${forwarded};
  var RESERVED = ${reserved};
  var nextId = 1;
  var pending = new Map();
  var listeners = new Map();
  function warn(error) { console.warn('[stacki] ' + (error && error.message)); }
  function emit(event, data) {
    var set = listeners.get(event);
    if (set) { set.forEach(function (listener) { try { listener(data); } catch (error) { console.error(error); } }); }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) { return; }
    var data = event.data;
    if (!data || data.stacki !== 'host' || data.v !== VERSION) { return; }
    if (typeof data.event === 'string') {
      emit(data.event, data.data);
      return;
    }
    var entry = pending.get(data.id);
    if (!entry) { return; }
    pending.delete(data.id);
    if (data.ok) { entry.resolve(data.value); return; }
    var error = new Error((data.error && data.error.message) || 'Stacki refused the request');
    error.code = data.error && data.error.code;
    entry.reject(error);
  });
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      if (pending.size >= IN_FLIGHT_MAX) {
        var busy = new Error('Too many requests are waiting for Stacki');
        busy.code = 'busy';
        reject(busy);
        return;
      }
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({ stacki: 'app', v: VERSION, id: id, method: method, params: params }, '*');
    });
  }
  function on(event, listener) {
    var set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
      request('events.subscribe', { events: [event] }).catch(function (error) { console.warn('[stacki] ' + event + ': ' + error.message); });
    }
    set.add(listener);
    return function off() {
      set.delete(listener);
      if (set.size === 0 && listeners.get(event) === set) {
        listeners.delete(event);
        request('events.unsubscribe', { events: [event] }).catch(function () {});
      }
    };
  }

  // Shortcuts (docs/apps.md, "Shortcuts and commands"), in this order: a
  // listener on an element or the document runs before this one on the window,
  // so its preventDefault() keeps any key in the app; a claimed shortcut is the
  // app's (heard as shortcut.press too); a key in the reserved range runs an app
  // command; an editor shortcut goes to Stacki unless a text field has focus,
  // whose own undo is the typing's. Shortcuts are canonical text, as
  // shared/properties/appShortcuts.ts writes them.
  var claims = new Set();
  var NAMED = ['Escape', 'Enter', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  function editableTarget(target) {
    if (!target || typeof target.closest !== 'function') { return false; }
    return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
  }
  function keyOf(event) {
    var code = typeof event.code === 'string' ? event.code : '';
    var letter = /^Key([A-Z])$/.exec(code);
    if (letter) { return letter[1]; }
    var digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (digit) { return digit[1]; }
    if (event.key === ' ') { return 'Space'; }
    if (NAMED.indexOf(event.key) >= 0) { return event.key; }
    return /^[A-Za-z0-9]$/.test(event.key) ? event.key.toUpperCase() : undefined;
  }
  function shortcutOf(event) {
    if (typeof event.key !== 'string') { return undefined; }
    var key = keyOf(event);
    if (key === undefined) { return undefined; }
    var parts = [];
    if (event.metaKey || event.ctrlKey) { parts.push('Mod'); }
    if (event.altKey) { parts.push('Alt'); }
    if (event.shiftKey) { parts.push('Shift'); }
    parts.push(key);
    return parts.join('+');
  }
  window.addEventListener('keydown', function (event) {
    var shortcut = shortcutOf(event);
    if (shortcut === undefined || event.defaultPrevented) { return; }
    if (claims.has(shortcut)) {
      emit('shortcut.press', { shortcut: shortcut });
      return;
    }
    if (RESERVED.indexOf(shortcut) >= 0) {
      event.preventDefault();
      request('commands.trigger', { shortcut: shortcut }).catch(warn);
      return;
    }
    var forwarded = Object.prototype.hasOwnProperty.call(FORWARDED, shortcut) ? FORWARDED[shortcut] : undefined;
    if (forwarded === undefined || editableTarget(event.target)) { return; }
    event.preventDefault();
    request('shortcuts.run', { shortcut: forwarded }).catch(warn);
  });
  // Where focus is, for Stacki's menu: its Undo goes to a focused text field here.
  var focusEditable = false;
  function noteFocus(editable) {
    if (editable === focusEditable) { return; }
    focusEditable = editable;
    request('shortcuts.focus', { editable: editable }).catch(function () {});
  }
  window.addEventListener('focusin', function (event) { noteFocus(editableTarget(event.target)); });
  window.addEventListener('focusout', function (event) { noteFocus(editableTarget(event.relatedTarget)); });
  function claim(shortcuts) {
    return request('shortcuts.claim', { shortcuts: shortcuts }).then(function (answer) {
      claims = new Set(answer.shortcuts);
      return answer;
    });
  }

  // Overrides: Stacki asks the app that owns a point, and the handler answers.
  // A handler that throws or answers nothing gets Stacki's own picker.
  var handlers = new Map();
  var calls = new Map();
  var hearingOverrides = false;
  function answerOverride(call, point, result) {
    calls.delete(call);
    return request('overrides.resolve', { call: call, point: point, result: result }).catch(function (error) {
      warn(error);
      if (result && result.kind !== 'default') { answerOverride(call, point, { kind: 'default' }); }
    });
  }
  function hearOverride(data) {
    var handler = handlers.get(data.point);
    if (!handler) { answerOverride(data.call, data.point, { kind: 'default' }); return; }
    var controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    calls.set(data.call, controller);
    Promise.resolve()
      .then(function () { return handler(data.context, { call: data.call, signal: controller && controller.signal }); })
      .then(
        function (result) { if (calls.has(data.call)) { answerOverride(data.call, data.point, result || { kind: 'default' }); } },
        function (error) { console.error(error); if (calls.has(data.call)) { answerOverride(data.call, data.point, { kind: 'default' }); } }
      );
  }
  function hearOverrideCancel(data) {
    var controller = calls.get(data.call);
    calls.delete(data.call);
    if (controller) { controller.abort(); }
  }
  function register(point, handler) {
    if (typeof handler !== 'function') { return Promise.reject(new TypeError('An override handler is a function')); }
    if (!hearingOverrides) {
      hearingOverrides = true;
      on('override.request', hearOverride);
      on('override.cancel', hearOverrideCancel);
    }
    handlers.set(point, handler);
    return request('overrides.register', { point: point });
  }
  function unregister(point) {
    handlers.delete(point);
    return request('overrides.unregister', { point: point });
  }

  // Custom frames: a handle whose \`closed\` resolves with what the frame closed with.
  var closers = new Map();
  var hearingFrames = false;
  function openFrame(params) {
    if (!hearingFrames) {
      hearingFrames = true;
      on('frame.close', function (data) {
        var done = closers.get(data.frameId);
        if (done) { closers.delete(data.frameId); done(data.result); }
      });
    }
    return request('ui.openFrame', params).then(function (opened) {
      var closed = new Promise(function (resolve) { closers.set(opened.frameId, resolve); });
      return Object.freeze({
        id: opened.frameId,
        closed: closed,
        close: function (result) { return request('ui.closeFrame', { frameId: opened.frameId, result: result }); }
      });
    });
  }

  // Drag to insert (docs/apps.md): this frame keeps the pressed pointer wherever it goes, so it
  // reports each move to Stacki, one at a time, and the drop or Escape ends it. Resolves with
  // the drop's answer, node.insert's: { applied, nodeId } or { applied: false, reason }.
  var dragging = false;
  function startInsertDrag(params) {
    if (dragging) { return Promise.reject(new Error('A drag to insert is already under way')); }
    return request('canvas.startInsertDrag', params).then(function (started) {
      if (!started || started.applied !== true) { return started; }
      dragging = true;
      return new Promise(function (resolve) {
        var waiting = false;
        var latest;
        var ended = false;
        function finish(answer) {
          ended = true;
          dragging = false;
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onCancel, true);
          window.removeEventListener('keydown', onKey, true);
          resolve(answer);
        }
        function send() {
          if (waiting || latest === undefined || ended) { return; }
          var point = latest;
          latest = undefined;
          waiting = true;
          request('canvas.insertDrag', { phase: 'move', x: point.x, y: point.y }).then(
            function () { waiting = false; send(); },
            function () { waiting = false; }
          );
        }
        function onMove(event) { latest = { x: event.clientX, y: event.clientY }; send(); }
        function onUp(event) {
          event.preventDefault();
          request('canvas.insertDrag', { phase: 'drop', x: event.clientX, y: event.clientY }).then(finish, function (error) {
            finish({ applied: false, reason: error.message });
          });
          ended = true;
        }
        function onCancel() {
          request('canvas.insertDrag', { phase: 'cancel' }).then(finish, function () { finish({ applied: false, reason: 'The drag was cancelled' }); });
          ended = true;
        }
        function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onCancel, true);
        window.addEventListener('keydown', onKey, true);
      });
    });
  }

  var api = { apiVersion: VERSION, request: request, on: on };
  var groups = ${groups};
  var custom = {
    overrides: { register: register, unregister: unregister },
    ui: { openFrame: openFrame },
    shortcuts: { claim: claim },
    canvas: { startInsertDrag: startInsertDrag }
  };
  Object.keys(groups).forEach(function (group) {
    var helpers = {};
    groups[group].forEach(function (name) {
      helpers[name] = function (params) { return request(group + '.' + name, params); };
    });
    var extra = custom[group] || {};
    Object.keys(extra).forEach(function (name) { helpers[name] = extra[name]; });
    api[group] = Object.freeze(helpers);
  });
  window.stacki = Object.freeze(api);
  // The manifest's claims, so they hold before the app calls shortcuts.claim.
  request('app.info').then(function (info) {
    if (info && Array.isArray(info.shortcutClaims)) { info.shortcutClaims.forEach(function (shortcut) { claims.add(shortcut); }); }
  }).catch(function () {});
})();
`;
  assert(source.includes('window.stacki'), 'The SDK defines window.stacki');
  for (const names of Object.values(HAND_WRITTEN_HELPERS)) {
    for (const name of names) {
      assert(source.includes(`${name}: ${name}`), 'Every hand-written helper is installed');
    }
  }
  return source;
}

/**
 * The policy an app document is served with. `sandbox` makes the document an
 * opaque origin even when opened outside its frame, so it can never act as
 * Stacki's own origin, read its storage or reach its API with its sign-in.
 * `origin` is where its files are served from (`stacki-app://id` on Desktop, the
 * Studio file route elsewhere).
 *
 * Local first (docs/apps.md, "External services"): code, styles and fonts load
 * from the bundle only, and the app connects, frames and posts forms only to the
 * hosts its manifest declares in `network` and its OAuth token endpoints
 * (`connectHosts`, appAuth.ts appConnectHosts). So the declaration the install
 * confirmation shows is the whole truth: an undeclared call fails. Images and
 * media may still come from any https address: they run no code, and an app
 * shows the project's own images, wherever they are hosted.
 */
export function appContentSecurityPolicy(origin: string, connectHosts: readonly string[]): string {
  assert(origin.length > 0, 'An app is served from somewhere');
  assert(!origin.includes(';'), 'An origin cannot add a directive');
  for (const host of connectHosts) {
    assert(/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host), 'A connect host is a bare host name');
  }
  const https = connectHosts.map((host) => ` https://${host}`).join('');
  const sockets = connectHosts.map((host) => ` wss://${host}`).join('');
  const directives = [
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline' 'wasm-unsafe-eval'`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob: https:`,
    `font-src ${origin} data:`,
    `media-src ${origin} blob: https:`,
    `connect-src ${origin}${https}${sockets}`,
    `frame-src ${origin}${https}`,
    `form-action ${origin}${https}`,
    "base-uri 'none'",
  ];
  return directives.join('; ');
}
