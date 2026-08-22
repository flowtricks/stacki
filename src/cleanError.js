// Error-message tidying, shared by App and the panels that surface failures.
//
// Lives outside App.jsx on purpose: a module that exports both a component and
// a plain function can't Fast Refresh, so every edit to App.jsx forced Vite
// into a full page reload — which drops the open project and lands you back on
// the dashboard mid-edit.

export function cleanError(err) {
  const msg = err?.message || String(err);
  return stripAnsi(msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
}

export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\[(\d{1,2})m/g, '');
}
