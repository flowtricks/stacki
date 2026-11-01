// Two or three choices, side by side, one of them on. The props panel's yes/no
// and the object field's use the same one — a boolean looks the same wherever
// it is asked about.
export default function SegSwitch<T extends string | number | boolean>({
  options,
  current,
  onPick,
}: {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly current?: T | undefined;
  readonly onPick: (value: T) => void;
}) {
  const at = options.findIndex((option) => option.value === current);
  return (
    <div className={`bool-seg ${at < 0 ? 'is-unset' : at === 1 ? 'is-second' : 'is-first'}`} role="group">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={option.value === current ? 'on' : ''}
          aria-pressed={option.value === current}
          title={option.label}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
