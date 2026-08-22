// Decides what a paste (or drop) into the embedded terminal should do.
//
// A pty carries only bytes, so an image can't travel through it, and xterm's
// built-in paste forwards clipboard TEXT only — so plain xterm drops images
// entirely. Forwarding a raw Ctrl+V (0x16) and letting the foreground CLI read
// the OS clipboard itself overcorrects: copied *files* and rich text+image
// copies (spreadsheet cells, browser and chat selections) also carry image
// items, and hijacking those breaks pastes a native terminal gets right. It
// also depends on a clipboard tool the CLI shells out to — osascript, xclip,
// wl-paste, PowerShell — which is frequently missing.
//
// So for a genuine image the bytes are handed back to the caller to persist as
// a temp file and paste the path, the route a dragged file already takes. 0x16
// stays only as the fallback for when those bytes aren't available.
//
// Ported from Meno (electron-app/src/components/terminalPaste.ts).
//
// Actions:
//   { kind: 'text' }            — let xterm's normal text paste run
//   { kind: 'paths', text }     — paste resolved filesystem path(s) as text
//   { kind: 'image', file }     — persist file's bytes, paste the temp path.
//                                 `file` is null when an image type was
//                                 advertised with no backing blob; the caller
//                                 then falls back to forwarding 0x16.

// Backslash-escape the way Terminal.app and iTerm do when pasting a copied
// file, so the path survives a shell prompt and matches the form CLIs already
// parse from a native drag-drop.
export function escapePosixPath(p) {
  return p.replace(/[^A-Za-z0-9_\-./]/g, (c) => `\\${c}`);
}

// Match what Explorer's drag-drop produces. Windows filenames can't contain
// double quotes, so plain wrapping is safe for PowerShell and CLIs alike.
export function quoteWindowsPath(p) {
  return /[\s&()^%;,=]/.test(p) ? `"${p}"` : p;
}

export function decideTerminalPaste(items, plainText, getPathForFile, isWindows) {
  // 1. Files copied in Finder/Explorer resolve to absolute paths — paste those,
  //    escaped like a native terminal would. At a shell prompt a full path
  //    beats the bare filename xterm's text flavor would insert, and coding
  //    agents attach file paths directly. Clipboard *data* (screenshots,
  //    "Copy image") also surfaces as kind:'file' but isn't filesystem-backed,
  //    so path resolution comes back empty and it falls to the image branch.
  const paths = [];
  let hasImage = false;
  let imageFile = null;
  for (const item of items) {
    const isImage = item.type.startsWith('image/');
    if (isImage) hasImage = true;
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    // Capture the first image blob's bytes whether or not it's
    // filesystem-backed — screenshots aren't.
    if (isImage && !imageFile) imageFile = file;
    if (!getPathForFile) continue;
    let p = '';
    try {
      p = getPathForFile(file) || '';
    } catch {
      /* in-memory File with no filesystem backing */
    }
    if (p) paths.push(p);
  }
  if (paths.length > 0) {
    const escape = isWindows ? quoteWindowsPath : escapePosixPath;
    return { kind: 'paths', text: paths.map(escape).join(' ') };
  }

  if (!hasImage) return { kind: 'text' };

  // 2. An image alongside meaningful text (spreadsheet cells and rich browser
  //    copies put both flavors on the clipboard): the text is what a native
  //    terminal pastes — keep it.
  if (plainText.trim()) return { kind: 'text' };

  // 3. Pure image data → persist the bytes and paste the temp file's path.
  return { kind: 'image', file: imageFile };
}
