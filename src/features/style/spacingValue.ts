// A spacing value as written: the value with its `!important` put back
// (SpacingBox.tsx).

export const withImportant = ({ value, important }: { value: string; important: boolean }) => (important ? `${value} !important` : value);
