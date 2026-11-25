// Original Stacki mark; see vendor/stacki/LICENSE for attribution.
export const stackiMarkPath =
  'M335.866 0C403.319 0 458 54.6814 458 122.134V335.866C458 403.319 403.319 45' +
  '8 335.866 458H122.134C54.6814 458 0 403.319 0 335.866V122.134C0 54.6814 54.' +
  '6814 0 122.134 0H335.866ZM137.973 107.63C121.215 107.63 107.63 121.215 107.' +
  '63 137.973V198.657C107.63 215.415 121.215 229 137.973 229H198.659C215.333 2' +
  '29 228.865 242.449 229.001 259.09C229 259.174 229 259.258 229 259.343V320.0' +
  '27C229 336.785 242.585 350.37 259.343 350.37H320.027C336.785 350.37 350.37 ' +
  '336.785 350.37 320.027V259.343C350.37 242.585 336.785 229 320.027 229H259.2' +
  '72C242.548 228.961 229.002 215.391 229.002 198.657C229.002 198.29 229.001 1' +
  '97.924 229 197.561V137.973C229 121.215 215.415 107.63 198.657 107.63H137.97' +
  '3Z';

export const stackiFavicon = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 458 458"><style>path{fill:#191919}@media(prefers-color-scheme:dark){path{fill:#fff}}</style><path d="${stackiMarkPath}"/></svg>`,
)}`;

// Keep the publishing badge at the lower left so the Stacki mark stays recognizable.
export const stackiPublishingFavicon = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 458 458"><style>path{fill:#191919}@media(prefers-color-scheme:dark){path{fill:#fff}}</style><path d="${stackiMarkPath}"/><circle cx="72" cy="386" r="62" fill="#22c55e" stroke="#191919" stroke-width="20"/></svg>`,
)}`;
