import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colorMode, formatColor, formatHex, hsvaToRgba, parseColor, rgbaToHsl, rgbaToHsva, type ColorMode, type HSVA, type RGBA } from '../shared/color'
import { dragNote, endDragNotes } from '../../ui/sound.js'
import { registerPopupLayer } from '../lib/popup-layer'

// A Webflow-style color chooser popover: a saturation/brightness square, hue and
// alpha sliders, an eyedropper, and hex / RGB / HSB inputs. Portaled to <body> and
// anchored under the swatch that opened it, so it clears the panel and any scroll.
// HSVA is the canonical internal state; output notation follows the input's (hex /
// rgb / hsl), with alpha forcing the alpha form.

type Props = {
  value: string
  anchor: DOMRect
  /** The swatch that opened the picker — excluded from the outside-close so clicking
   *  it again toggles closed instead of closing-then-reopening. */
  trigger?: HTMLElement | null
  onChange: (color: string, live: boolean) => void
  onClose: () => void
}

const CHECKER = 'repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%) 50% / 10px 10px'
const HUE_BAR = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Track the pointer across a drag on `el`, reporting a 0..1 fraction of its width
// (and, for the 2D square, height). Live during the drag; committed on release.
// `tall` says the vertical is worth hearing: the saturation square is a surface
// you drag around in, the hue and alpha bars are a few pixels high, where a
// fraction of the height is noise rather than intent.
function useDrag(onMove: (fx: number, fy: number, live: boolean) => void, tall = false) {
  return (el: HTMLElement, e: React.PointerEvent) => {
    const rect = el.getBoundingClientRect()
    const report = (ev: PointerEvent | React.PointerEvent, live: boolean) => {
      const fx = clamp((ev.clientX - rect.left) / rect.width, 0, 1)
      const fy = clamp((ev.clientY - rect.top) / rect.height, 0, 1)
      // A note as the value moves: pitched by where along the track it is —
      // right higher, left lower — and, on the square, played harder the higher
      // up it is. The same on all three of these, because they are one gesture
      // wearing three shapes. Silent unless the setting is on, and it decides
      // for itself which moves are worth a sound.
      if (live) dragNote(fx, tall ? fy : undefined)
      onMove(fx, fy, live)
    }
    report(e, true)
    const move = (ev: PointerEvent) => report(ev, true)
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      report(ev, false)
      // The next drag sounds its first step, wherever it starts.
      endDragNotes()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
}

function Field({ label, value, onChange, wide }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean }) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  return (
    <label className={`u-color-field ${wide ? 'is-wide' : ''}`}>
      <input
        className="u-input u-color-field-input"
        value={text}
        spellCheck={false}
        onChange={(e) => { setText(e.target.value); onChange(e.target.value) }}
        onFocus={(e) => { focused.current = true; e.target.select() }}
        onBlur={() => { focused.current = false; setText(value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.currentTarget.blur(); return }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          // Step numeric fields (R/G/B, H/S/L/B, A) by 1 (10 with Shift). A non-numeric
          // value like a hex string parses to NaN → left to the browser's default.
          const n = parseFloat(text)
          if (Number.isNaN(n)) return
          e.preventDefault()
          const next = String(n + (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1))
          setText(next)
          onChange(next)
        }}
        aria-label={label}
      />
    </label>
  )
}

const EyedropperIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true"><path d="M10.5 2.5a1.7 1.7 0 0 1 2.4 2.4l-1 1 1 1-1.2 1.2-1-1L6 12.8 3 13.5l.7-3 4.1-4.1-1-1L8 4.2l1 1 1-1a1.7 1.7 0 0 1 .5-.4Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" /></svg>
)

export default function ColorPicker({ value, anchor, trigger, onChange, onClose }: Props) {
  const parsed = useRef<RGBA>(parseColor(value) ?? { r: 0, g: 0, b: 0, a: value.trim() ? 1 : 0 })
  const [hsva, setHsva] = useState<HSVA>(() => rgbaToHsva(parsed.current))
  // HEX is ALWAYS visible (its own field); the toggle only cycles the channel
  // notation shown in the middle three fields (RGB → HSL → HSB). Output notation
  // follows the active channel — hsb has no CSS form, so it emits rgb.
  // What the picker WRITES. It opens on whatever notation the value is already
  // in, so opening a picker on a colour never rewrites it.
  //
  // HSB used to be the third: it is what Figma and Photoshop show, but CSS has
  // no `hsb()`, so choosing it wrote rgb() and the toggle looked broken — the
  // numbers changed and the declaration didn't. The three here are the three
  // CSS can actually spell.
  // Two separate questions, because they have two separate buttons. `channel` is
  // what the three number fields show — the pill under them toggles it. `asHex`
  // is whether the colour is WRITTEN as hex — the HEX button turns that on, and
  // pressing the pill turns it off, since the pill's letters then describe the
  // notation as well as the numbers.
  //
  // Hex doesn't belong in the pill's cycle: it isn't a third kind of channel,
  // it is R/G/B spelled differently, and it has a label of its own sitting right
  // beside them.
  const [channel, setChannel] = useState<'rgb' | 'hsl'>(() =>
    colorMode(value) === 'hsl' ? 'hsl' : 'rgb',
  )
  // Nothing set yet is no notation to preserve, and a colour written for the
  // first time should come out the way this panel has always written one.
  const [asHex, setAsHex] = useState(() => !!value.trim() && colorMode(value) === 'hex')
  // What a write is formatted as.
  const notation: ColorMode = asHex ? 'hex' : channel
  // Choosing a notation rewrites the declaration in it. Without that the toggle
  // changed only the three fields, leaving the CSS as whatever it was last
  // written in: picking HSL showed H/S/L and left `rgb(224, 4, 4)` in the file,
  // which is the toggle appearing to do nothing to the thing it is about.
  //
  // Nothing to rewrite when nothing is set: a colour nobody has chosen should
  // not become one because a notation was picked.
  const writeAs = (mode: ColorMode) => {
    if (value.trim()) onChange(formatColor(hsvaToRgba(hsva), mode), false)
  }
  // The pill: rgb ↔ hsl. From hex it comes back to whichever of the two its
  // letters are already showing, rather than flipping to the other one — the
  // letters are what was pressed.
  const toggleChannel = () => {
    const next = asHex ? channel : channel === 'rgb' ? 'hsl' : 'rgb'
    setAsHex(false)
    setChannel(next)
    writeAs(next)
  }
  const chooseHex = () => {
    setAsHex(true)
    writeAs('hex')
  }
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // A colour nobody has set yet opens at alpha 0 — there is no colour, and
  // `transparent` is the honest way to show that. But it makes the first drag
  // useless: the square picks a hue that renders as nothing, so the field fills
  // in and the page doesn't change. So while the alpha is 0 and nobody has said
  // it should be, the first drag means "this colour, visible", and the alpha
  // comes up with it.
  //
  // Keyed on the alpha rather than on whether the property was set, because the
  // two are the same thing to look at: an unset colour and one set to
  // `transparent` both read as "transparent" in the field, and a drag on either
  // is somebody asking for a colour they can see.
  //
  // Only until the alpha is somebody's choice. Move the slider, type in A, paste
  // a hex with alpha in it, and that is the opacity — including 0, which is then
  // a decision rather than a starting point.
  const alphaChosen = useRef(false)
  const chooseAlpha = () => { alphaChosen.current = true }
  // The alpha a drag on hue or saturation should carry.
  const withAlpha = (next: HSVA): HSVA =>
    alphaChosen.current || next.a > 0 ? next : { ...next, a: 1 }

  const emit = (next: HSVA, live: boolean) => { setHsva(next); onChange(formatColor(hsvaToRgba(next), notation), live) }
  const rgba = hsvaToRgba(hsva)
  const hsl = rgbaToHsl(rgba)
  const hueColor = formatHex({ ...hsvaToRgba({ h: hsva.h, s: 100, v: 100, a: 1 }), a: 1 })

  // Position under the swatch, clamped to the viewport.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const w = el.offsetWidth || 240
    const h = el.offsetHeight || 300
    const left = clamp(anchor.left, 8, window.innerWidth - w - 8)
    const below = anchor.bottom + 6
    const top = below + h > window.innerHeight - 8 && anchor.top - h - 6 > 8 ? anchor.top - h - 6 : below
    setPos({ top, left })
  }, [anchor])

  // Announce this popup and the swatch it belongs to, so the popover that swatch
  // lives in doesn't read a press in here as a press outside itself.
  useLayoutEffect(() => registerPopupLayer(rootRef.current, trigger ?? null), [trigger])

  // Close on outside pointerdown / Escape.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !trigger?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [onClose, trigger])

  const dragSB = useDrag((fx, fy, live) => emit(withAlpha({ ...hsva, s: Math.round(fx * 100), v: Math.round((1 - fy) * 100) }), live), true)
  const dragHue = useDrag((fx, _fy, live) => emit(withAlpha({ ...hsva, h: Math.round(fx * 360) }), live))
  const dragAlpha = useDrag((fx, _fy, live) => { chooseAlpha(); emit({ ...hsva, a: Math.round(fx * 100) / 100 }, live) })

  const setFromColor = (input: string, live: boolean) => {
    const c = parseColor(input)
    if (!c) return
    // A value typed or picked whole says what its own alpha is.
    chooseAlpha()
    const next = rgbaToHsva(c)
    // Preserve hue/sat when picking a greyscale value so the square doesn't jump.
    if (next.s === 0) next.h = hsva.h
    if (next.v === 0 || next.s === 0) next.s = next.s === 0 ? hsva.s : next.s
    setHsva(next)
    onChange(formatColor(c, notation), live)
  }
  const eyedrop = () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) return
    new ED().open().then((r) => setFromColor(r.sRGBHex, false)).catch(() => {})
  }

  const setNum = (key: 'h' | 's' | 'v' | 'a', raw: string, max: number) => {
    const n = parseFloat(raw)
    if (Number.isNaN(n)) return
    if (key === 'a') chooseAlpha()
    const next = { ...hsva, [key]: key === 'a' ? clamp(n / 100, 0, 1) : clamp(n, 0, max) }
    emit(key === 'a' ? next : withAlpha(next), false)
  }
  const alphaPct = Math.round(hsva.a * 100)

  // The three middle channel fields. Hex is rgb in another spelling, so those two
  // share R/G/B — what changes between them is how the value is written out, and
  // the label row below says which.
  const asHsl = channel === 'hsl'
  const chLabels = asHsl ? ['H', 'S', 'L'] : ['R', 'G', 'B']
  const chVals = asHsl
    ? [String(hsl.h), String(hsl.s), String(hsl.l)]
    : [String(rgba.r), String(rgba.g), String(rgba.b)]
  const setCh = (i: number, v: string) => {
    if (asHsl) {
      setFromColor(`hsla(${i === 0 ? v : hsl.h}, ${i === 1 ? v : hsl.s}%, ${i === 2 ? v : hsl.l}%, ${rgba.a})`, false)
    } else {
      setFromColor(`rgba(${i === 0 ? v : rgba.r}, ${i === 1 ? v : rgba.g}, ${i === 2 ? v : rgba.b}, ${rgba.a})`, false)
    }
  }

  return createPortal(
    <div ref={rootRef} className="u-color-picker" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }} role="dialog" aria-label="Color picker">
      <div
        className="u-color-sb"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={(e) => { e.preventDefault(); dragSB(e.currentTarget, e) }}
      >
        <span className="u-color-sb-thumb" style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%`, background: formatHex(rgba) }} />
      </div>

      <div className="u-color-sliders">
        <button type="button" className={`u-color-eyedrop ${typeof (window as { EyeDropper?: unknown }).EyeDropper === 'function' ? '' : 'is-hidden'}`} onClick={eyedrop} title="Pick a color from the screen" aria-label="Eyedropper"><EyedropperIcon /></button>
        <div className="u-color-slider-stack">
          <div className="u-color-slider" style={{ background: HUE_BAR }} onPointerDown={(e) => { e.preventDefault(); dragHue(e.currentTarget, e) }}>
            <span className="u-color-slider-thumb" style={{ left: `${(hsva.h / 360) * 100}%` }} />
          </div>
          <div className="u-color-slider u-color-alpha" style={{ ['--picker-checker' as string]: CHECKER }} onPointerDown={(e) => { e.preventDefault(); dragAlpha(e.currentTarget, e) }}>
            <span className="u-color-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${hueColorWithSat(hsva)})` }} />
            <span className="u-color-slider-thumb" style={{ left: `${alphaPct}%` }} />
          </div>
        </div>
      </div>

      {/* HEX is always present; the middle three fields follow the channel notation. */}
      <div className="u-color-inputs">
        <Field label="HEX" wide value={formatHex(rgba)} onChange={(v) => setFromColor(v, false)} />
        <div className="u-color-channels">
          {chLabels.map((lab, i) => (
            <Field key={i} label={lab} value={chVals[i]} onChange={(v) => setCh(i, v)} />
          ))}
        </div>
        <Field label="A" value={String(alphaPct)} onChange={(v) => setNum('a', v, 100)} />
      </div>

      {/* Column labels and the notation, in one row. The letters say what the
          numbers above them ARE; the highlight says how the colour is written
          into the CSS. Those are the same thing for RGB and HSL and not for
          HEX, where the numbers are still R/G/B — so in hex the HEX label
          lights and the letters stay honest. Two buttons, two jobs: HEX picks
          hex, the pill toggles rgb and hsl. */}
      <div className="u-color-modes">
        <button
          type="button"
          className={`u-color-mode is-hex ${asHex ? 'is-on' : ''}`}
          onClick={chooseHex}
          aria-pressed={asHex}
          title="Write this colour as hex"
        >
          HEX
        </button>
        <button
          type="button"
          className={`u-color-mode is-channel ${asHex ? 'is-off' : ''}`}
          onClick={toggleChannel}
          aria-pressed={!asHex}
          aria-label={`Written as ${notation}. Press for ${channel === 'rgb' ? 'hsl' : 'rgb'}`}
          title="Toggle rgb() / hsl()"
        >
          {chLabels.map((lab, i) => <span key={i}>{lab}</span>)}
        </button>
        <span className="u-color-mode-static is-alpha">A</span>
      </div>
    </div>,
    document.body,
  )
}

function hueColorWithSat(hsva: HSVA): string {
  return formatHex({ ...hsvaToRgba({ ...hsva, a: 1 }), a: 1 })
}
