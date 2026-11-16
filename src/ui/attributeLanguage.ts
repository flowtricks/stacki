// Which language an attribute's value is written in, by the attribute's name.
//
// The properties panel types values into fields, and a value like `sizes` is
// code in all but name: media conditions and lengths. Grey text in a field
// reads as prose, so a field takes its colours from this one table, decided by
// the attribute rather than by the field that happens to draw it. The table is
// pure data: the grammar each name stands for lives in attributeSyntax.ts, and
// the editor that wears it in the props feature (CodeBindInput.tsx).
//
// Prose stays out on purpose: `alt`, `title`, `label`, `aria-label` and a
// description are sentences, and colouring the words of a sentence only adds
// noise. `href` and `src` are paths, not code, until they are written as an
// expression, and an expression is JavaScript wherever it appears.

/** The grammars a value can take. `declarations` is the `style` attribute's: see StyleEditor.tsx. */
export type AttributeLanguage =
  'declarations' | 'javascript' | 'json' | 'keyValues' | 'mediaQuery' | 'pathData' | 'regex' | 'sourceSet' | 'svgNumbers' | 'tokens';

/** A name with no grammar of its own is plain: undefined, never a guess. */
const BY_NAME: Readonly<Record<string, AttributeLanguage>> = {
  accept: 'tokens',
  allow: 'tokens',
  d: 'pathData',
  gradienttransform: 'svgNumbers',
  imagesizes: 'mediaQuery',
  imagesrcset: 'sourceSet',
  media: 'mediaQuery',
  patterntransform: 'svgNumbers',
  pattern: 'regex',
  points: 'svgNumbers',
  rel: 'tokens',
  sandbox: 'tokens',
  sizes: 'mediaQuery',
  srcset: 'sourceSet',
  strokedasharray: 'svgNumbers',
  style: 'declarations',
  transform: 'svgNumbers',
  type: 'tokens',
  viewbox: 'svgNumbers',
};

/** A name that is code only on one element: `<meta content>` is a list, `<p content>` is not. */
const BY_ELEMENT_AND_NAME: Readonly<Record<string, AttributeLanguage>> = {
  'meta.content': 'keyValues',
};

/** The longest name looked up: a longer one is never in the table, so it is not scanned. */
const NAME_CHARS_MAX = 128;

/**
 * The language an attribute's text is in, or undefined when it is plain.
 * Names compare without case, hyphens and underscores, so `viewBox`, `viewbox`
 * and a prop spelled `view-box` are one name, and `stroke-dasharray` is
 * `strokedasharray`. `on*` handlers are JavaScript; `data-*` is not decided by
 * name (see `dataLanguage`).
 */
export function attributeLanguage(name: string, element?: string | undefined): AttributeLanguage | undefined {
  if (name.length === 0 || name.length > NAME_CHARS_MAX) {
    return undefined;
  }
  const key = name.toLowerCase().replace(/[-_]/g, '');
  const scoped = element === undefined ? undefined : BY_ELEMENT_AND_NAME[`${element.toLowerCase()}.${key}`];
  if (scoped !== undefined) {
    return scoped;
  }
  if (Object.hasOwn(BY_NAME, key)) {
    return BY_NAME[key];
  }
  // An inline event handler is a program: `onclick`, `onmouseover`. `once`, `one` and `online` are not.
  if (/^on[a-z]{3,}$/.test(key) && EVENT_NAMES.has(key.slice(2))) {
    return 'javascript';
  }
  return undefined;
}

/**
 * `data-*` holds anything: `data-label="Click me"` is prose and
 * `data-config='{"a":1}'` is JSON. The text decides, so a value that opens
 * like JSON is JSON and nothing else is coloured.
 */
export function dataLanguage(name: string, text: string): AttributeLanguage | undefined {
  if (!/^data-./i.test(name)) {
    return undefined;
  }
  return /^\s*[[{]/.test(text) ? 'json' : undefined;
}

/** The language of an attribute with its value known: its name's, else `data-*`'s by what it holds. */
export function attributeLanguageOf(name: string, text: string, element?: string | undefined): AttributeLanguage | undefined {
  return attributeLanguage(name, element) ?? dataLanguage(name, text);
}

// The events the platform names, so a prop that merely starts with "on" (`once`, `onboarding`) stays plain.
const EVENT_NAMES: ReadonlySet<string> = new Set([
  'abort',
  'animationend',
  'animationiteration',
  'animationstart',
  'auxclick',
  'beforeinput',
  'beforeunload',
  'blur',
  'cancel',
  'canplay',
  'canplaythrough',
  'change',
  'click',
  'close',
  'contextmenu',
  'copy',
  'cut',
  'dblclick',
  'drag',
  'dragend',
  'dragenter',
  'dragleave',
  'dragover',
  'dragstart',
  'drop',
  'durationchange',
  'ended',
  'error',
  'focus',
  'focusin',
  'focusout',
  'formdata',
  'gotpointercapture',
  'hashchange',
  'input',
  'invalid',
  'keydown',
  'keypress',
  'keyup',
  'load',
  'loadeddata',
  'loadedmetadata',
  'loadstart',
  'lostpointercapture',
  'message',
  'mousedown',
  'mouseenter',
  'mouseleave',
  'mousemove',
  'mouseout',
  'mouseover',
  'mouseup',
  'offline',
  'online',
  'pagehide',
  'pageshow',
  'paste',
  'pause',
  'play',
  'playing',
  'pointercancel',
  'pointerdown',
  'pointerenter',
  'pointerleave',
  'pointermove',
  'pointerout',
  'pointerover',
  'pointerup',
  'popstate',
  'progress',
  'ratechange',
  'reset',
  'resize',
  'scroll',
  'scrollend',
  'securitypolicyviolation',
  'seeked',
  'seeking',
  'select',
  'selectionchange',
  'slotchange',
  'stalled',
  'storage',
  'submit',
  'suspend',
  'timeupdate',
  'toggle',
  'touchcancel',
  'touchend',
  'touchmove',
  'touchstart',
  'transitionend',
  'transitionrun',
  'transitionstart',
  'unload',
  'volumechange',
  'waiting',
  'wheel',
]);
