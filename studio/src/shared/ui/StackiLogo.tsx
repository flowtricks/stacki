import { stackiMarkPath } from '../stackiBrand';

export function StackiLogo() {
  return (
    // i18n-ignore: brand name of the product, shown as written in every language.
    <svg width="26" height="26" viewBox="0 0 458 458" role="img" aria-label="Stacki">
      <path d={stackiMarkPath} fill="currentColor" />
    </svg>
  );
}
