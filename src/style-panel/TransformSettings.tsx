import { useEffect, useRef, useState } from 'react'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import DragSlider from './components/DragSlider'
import { PositionGrid, NumField } from './components/PositionGrid'
import FieldLabel from './components/FieldLabel'
import { PropTip, useHoverTip } from './components/PropTip'
import { useComputedChoice } from './lib/computed-style'
import { handleArrowStep } from './lib/number-step'
import { commitInPlace } from './lib/commit-in-place'
import { parseOrigin, serializeOrigin, type Origin } from './lib/transform-settings'
import type { ResolvedProp } from './lib/resolved'

// The settings behind the transform list, opened from the ⋯ beside its +: where a
// transform pivots, whether a turned element shows its back, and the two
// perspectives. Everything here applies to the whole element rather than to one
// layer, which is why it is not in the per-layer editor.
//
// See lib/transform-settings.ts for what "self" and "children" perspective
// actually mean in CSS — they are different properties, and the self one has to
// lead the transform list to mean what it says.

type Read = (prop: string) => ResolvedProp | undefined
type SetProp = (prop: string, value: string, important: boolean) => void
type ClearProp = (prop: string | string[]) => void

const BACKFACE: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
]

// Far enough for the flat-looking end of the range to be reachable; a perspective
// past this is indistinguishable from none.
const MAX_DISTANCE = 2000

const val = (read: Read, prop: string): string => {
  const r = read(prop)
  if (!r) return ''
  return (r.source === 'selected' && r.selectedValue ? r.selectedValue.value : r.winner.value).trim()
}

const pxNumber = (value: string): number | null => {
  const m = value.trim().match(/^(-?\d*\.?\d+)\s*px$/i)
  return m ? parseFloat(m[1]) : null
}

/** A section heading, with the properties it writes on hover. */
function Heading({ title, props, note, busy, onClear, cleared }: {
  title: string; props: readonly string[]; note?: string; busy: boolean; onClear: () => void; cleared: boolean
}) {
  const help = useHoverTip<HTMLSpanElement>(note ? <PropTip props={props} note={note} /> : null)
  return (
    <div className="embed-editor_tsettings-head">
      <FieldLabel
        className="embed-editor_tsettings-title"
        active={cleared}
        disabled={busy}
        onReset={onClear}
        resetLabel="Clear"
        tooltip={<PropTip props={props} />}
      >
        {title}
      </FieldLabel>
      {note ? (
        <>
          <span className="embed-editor_tsettings-help" ref={help.ref} {...help.hoverProps} aria-label={note} role="img">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6.4 6.2a1.7 1.7 0 1 1 1.9 1.7v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="8.3" cy="11.2" r=".7" fill="currentColor" />
            </svg>
          </span>
          {help.tip}
        </>
      ) : null}
    </div>
  )
}

/** The pad plus its Left/Top fields — the same control as the gradient centre. */
function OriginRow({ label, origin, busy, ariaLabel, onChange }: {
  label: string; origin: Origin; busy: boolean; ariaLabel: string
  onChange: (next: Origin, live: boolean) => void
}) {
  return (
    <div className="embed-editor_size-row embed-editor_grad-pos-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">{label}</span>
      <div className="embed-editor_grad-pos">
        <PositionGrid
          x={origin.x}
          y={origin.y}
          busy={busy}
          ariaLabel={ariaLabel}
          onPick={(px, py) => onChange({ ...origin, x: px, y: py }, false)}
        />
        <div className="embed-editor_grad-pos-fields">
          {/* A <div>, not a <label>: the field here is VariableConnect's contenteditable
              editor, and the plain input behind it is opacity:0 / pointer-events:none.
              A <label> forwards a press to its labelable control — which is that
              invisible input — so clicking the field you can see moved the caret
              into one you cannot. The caption is decorative; the input carries its
              own aria-label. */}
          <div className="embed-editor_grad-pos-field"><span>Left</span>
            <NumField value={origin.x} unit="%" label={`${ariaLabel} left`} busy={busy} prop="left"
              onLive={(v) => onChange({ ...origin, x: v }, true)} onCommit={(v) => onChange({ ...origin, x: v }, false)} />
          </div>
          <div className="embed-editor_grad-pos-field"><span>Top</span>
            <NumField value={origin.y} unit="%" label={`${ariaLabel} top`} busy={busy} prop="top"
              onLive={(v) => onChange({ ...origin, y: v }, true)} onCommit={(v) => onChange({ ...origin, y: v }, false)} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** A perspective distance: a coarse slider beside the number, in px. */
function DistanceRow({ value, busy, ariaLabel, onLive, onCommit }: {
  value: string; busy: boolean; ariaLabel: string
  onLive: (v: string) => void; onCommit: (v: string) => void
}) {
  // null for a var()/calc(): the slider has no number to sit at, so it disables
  // while the field stays editable.
  const num = pxNumber(value)
  const [draft, setDraft] = useState(value || '0')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value || '0') }, [value])
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Distance</span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={num ?? 0}
          min={0}
          max={MAX_DISTANCE}
          disabled={busy || (value.trim() !== '' && num === null)}
          ariaLabel={ariaLabel}
          onPreview={(n) => { if (!focused.current) setDraft(`${n}px`) }}
          onInput={(n) => onLive(`${n}px`)}
          onCommit={(n) => onCommit(n === 0 ? '' : `${n}px`)}
        />
        <input
          className="u-input embed-editor_size-input embed-editor_shadow-num"
          value={draft}
          spellCheck={false}
          disabled={busy}
          aria-label={ariaLabel}
          placeholder="0"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => { focused.current = true }}
          onBlur={() => {
            focused.current = false
            const t = draft.trim()
            onCommit(!t || /^0(?:px)?$/i.test(t) ? '' : /[a-z%)]$/i.test(t) ? t : `${t}px`)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
            const stepped = handleArrowStep(e)
            if (!stepped) return
            e.preventDefault()
            e.currentTarget.value = stepped.text
            e.currentTarget.setSelectionRange(stepped.caret, stepped.caret)
            setDraft(stepped.text)
          }}
        />
        <span className="embed-editor_tsettings-unit">PX</span>
      </div>
    </div>
  )
}

export default function TransformSettings({ read, busy, setProp, clearProp, selfPerspective, onSelfPerspective }: {
  read: Read
  busy: boolean
  setProp: SetProp
  clearProp: ClearProp
  /** The `perspective()` inside the element's own transform, which its row owns. */
  selfPerspective: string
  onSelfPerspective: (distance: string, live: boolean) => void
}) {
  const transformOrigin = parseOrigin(val(read, 'transform-origin'))
  const perspectiveOrigin = parseOrigin(val(read, 'perspective-origin'))
  const backface = val(read, 'backface-visibility').toLowerCase()
  // Nothing authored → highlight what the page actually computes for this element,
  // falling back to the CSS initial value when there is no canvas to ask. Without
  // this the control showed NEITHER segment lit, which reads as "no answer" when
  // the real answer is always one or the other — backface-visibility has no unset
  // state at render time, it is `visible` until something says otherwise.
  const childDistance = val(read, 'perspective')
  const computedBackface = useComputedChoice(backface ? '' : 'backface-visibility', ['visible', 'hidden'])

  const writeOrigin = (prop: string, next: Origin) => {
    const value = serializeOrigin(next)
    // The centre IS the default, so writing `50% 50%` would leave a declaration
    // that says nothing — clear it instead and let the property go back to unset.
    if (value) setProp(prop, value, false)
    else clearProp(prop)
  }

  return (
    <div className="embed-editor_tsettings">
      <section className="embed-editor_tsettings-section">
        <Heading
          title="Transform settings"
          props={['transform-origin', 'backface-visibility']}
          busy={busy}
          cleared={!!val(read, 'transform-origin') || !!backface}
          onClear={() => clearProp(['transform-origin', 'backface-visibility'])}
        />
        <OriginRow
          label="Origin"
          origin={transformOrigin}
          busy={busy}
          ariaLabel="Transform origin"
          onChange={(next) => writeOrigin('transform-origin', next)}
        />
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Backface</span>
          <SegmentedControl
            value={backface || computedBackface || 'visible'}
            options={BACKFACE}
            onChange={(v) => setProp('backface-visibility', v, false)}
            ariaLabel="Backface visibility"
            disabled={busy}
          />
        </div>
      </section>

      <section className="embed-editor_tsettings-section">
        <Heading
          title="Self perspective"
          props={['transform']}
          note="Depth for this element's own transform — written as perspective() at the front of the transform list."
          busy={busy}
          cleared={!!selfPerspective}
          onClear={() => onSelfPerspective('', false)}
        />
        <DistanceRow
          value={selfPerspective}
          busy={busy}
          ariaLabel="Self perspective distance"
          onLive={(v) => onSelfPerspective(v, true)}
          onCommit={(v) => onSelfPerspective(v, false)}
        />
      </section>

      <section className="embed-editor_tsettings-section">
        <Heading
          title="Children perspective"
          props={['perspective', 'perspective-origin']}
          note="Depth for this element's CHILDREN, so they share one viewpoint. It does nothing to the element itself."
          busy={busy}
          cleared={!!childDistance || !!val(read, 'perspective-origin')}
          onClear={() => clearProp(['perspective', 'perspective-origin'])}
        />
        <DistanceRow
          value={childDistance}
          busy={busy}
          ariaLabel="Children perspective distance"
          onLive={(v) => { if (v) setProp('perspective', v, false) }}
          onCommit={(v) => { if (v) setProp('perspective', v, false); else clearProp('perspective') }}
        />
        <OriginRow
          label="Origin"
          origin={perspectiveOrigin}
          busy={busy}
          ariaLabel="Perspective origin"
          onChange={(next) => writeOrigin('perspective-origin', next)}
        />
      </section>
    </div>
  )
}
