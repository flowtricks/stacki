import { useMemo } from 'react'
import Select, { type SelectOption } from './components/Select'
import { selectorKey, type MatchedSelector } from './lib/resolved'
import {
  STATE_DEFINITIONS,
  STATE_GROUP_LABEL,
  splitState,
  stateDefinition,
  withState,
  type StateGroup,
} from './lib/states'

// Webflow's state dropdown: the class stays put, the state changes. Choosing
// Hover on `.card` targets `.card:hover`; None goes back to `.card`. Every choice
// is just another selector handed to the same `onSelect` a chip click uses, so the
// panel below reads and writes it exactly as it would a typed `.card:hover`.

type StateSelectProps = {
  readonly selectors: readonly MatchedSelector[]
  readonly activeSelector: string
  readonly busy: boolean
  readonly onSelect: (selector: string) => void
}

const GROUP_ORDER: readonly StateGroup[] = ['interaction', 'form', 'position', 'element']
const NONE = ''

// The states that already carry styles for this base, so the list can mark them
// the way Webflow dots a state that has changes.
function styledSuffixes(selectors: readonly MatchedSelector[], base: string): ReadonlySet<string> {
  const baseKey = selectorKey(base)
  const styled = new Set<string>()
  for (const chip of selectors) {
    const split = splitState(chip.text)
    if (split.suffix !== NONE && selectorKey(split.base) === baseKey) {
      styled.add(split.suffix)
    }
  }
  return styled
}

function stateOptions(styled: ReadonlySet<string>): SelectOption<string>[] {
  const options: SelectOption<string>[] = [{ value: NONE, label: 'None' }]
  for (const group of GROUP_ORDER) {
    options.push({ value: `heading:${group}`, label: STATE_GROUP_LABEL[group], heading: true })
    for (const definition of STATE_DEFINITIONS) {
      if (definition.group === group) {
        options.push({
          value: definition.suffix,
          label: definition.label,
          indent: true,
          marked: styled.has(definition.suffix),
        })
      }
    }
  }
  return options
}

export default function StateSelect({
  selectors,
  activeSelector,
  busy,
  onSelect,
}: StateSelectProps) {
  const { base, suffix } = splitState(activeSelector)
  const styled = useMemo(() => styledSuffixes(selectors, base), [selectors, base])
  const options = useMemo(() => stateOptions(styled), [styled])
  // A trailing state the list does not know (`:where(...)`, a vendor pseudo) is
  // left to the chips: showing None for it would make picking None a lie.
  const known = suffix === NONE || stateDefinition(suffix) !== undefined
  const value = known ? suffix : NONE
  return (
    <div className="embed-editor_state-row">
      <span className="embed-editor_state-label">State</span>
      <Select
        value={value}
        options={options}
        ariaLabel="Selector state"
        className="embed-editor_state-select"
        disabled={busy || !base}
        onChange={(next) => onSelect(withState(base, next))}
      />
    </div>
  )
}
