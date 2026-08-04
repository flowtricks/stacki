import React, { useState } from 'react';
import CodeEditor from './CodeEditor.jsx';
import { CloseIcon, CodeIcon } from './Icons.jsx';

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const MIN_W = 340;
const MIN_H = 220;

// Floating, draggable, resizable code editor window. Non-modal: the rest of
// the app stays interactive while it's open.
export default function CodeWindow({ title, language, value, onChange, onClose, editorKey }) {
  // Opens proportional to the window rather than at a fixed size: embeds and
  // frontmatter are usually real code, and a small default meant resizing it
  // every time. Capped so it stays a floating window on a wide monitor, and
  // floored at the minimums so a short window still gets something usable.
  const [rect, setRect] = useState(() => {
    const w = clamp(Math.round(window.innerWidth * 0.52), MIN_W, 1040);
    const h = clamp(Math.round(window.innerHeight * 0.78), MIN_H, window.innerHeight - 140);
    return {
      // Right-anchored, as before — the canvas stays visible to its left.
      x: Math.max(60, window.innerWidth - w - 80),
      y: 96,
      w,
      h,
    };
  });

  const startDrag = (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const { x, y } = rect;
    const onMove = (ev) => {
      setRect((r) => ({
        ...r,
        x: clamp(x + ev.clientX - sx, -r.w + 120, window.innerWidth - 60),
        y: clamp(y + ev.clientY - sy, 42, window.innerHeight - 48),
      }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startResize = (edge) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = { ...rect };
    const onMove = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      setRect(() => {
        let { x, y, w, h } = start;
        if (edge.includes('e')) w = Math.max(MIN_W, start.w + dx);
        if (edge.includes('s')) h = Math.max(MIN_H, start.h + dy);
        if (edge.includes('w')) {
          w = Math.max(MIN_W, start.w - dx);
          x = start.x + (start.w - w);
        }
        if (edge.includes('n')) {
          h = Math.max(MIN_H, start.h - dy);
          y = start.y + (start.h - h);
        }
        return { x, y, w, h };
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className="code-window"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div className="code-window-header" onPointerDown={startDrag}>
        <CodeIcon size={13} />
        <span className="code-window-title">{title}</span>
        <span className="type-tag">{language}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close (edits are saved live)" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="code-window-body">
        <CodeEditor key={editorKey} language={language} value={value} onChange={onChange} />
      </div>
      <div className="cw-rz cw-rz-n" onPointerDown={startResize('n')} />
      <div className="cw-rz cw-rz-s" onPointerDown={startResize('s')} />
      <div className="cw-rz cw-rz-e" onPointerDown={startResize('e')} />
      <div className="cw-rz cw-rz-w" onPointerDown={startResize('w')} />
      <div className="cw-rz cw-rz-se" onPointerDown={startResize('se')} />
      <div className="cw-rz cw-rz-sw" onPointerDown={startResize('sw')} />
      <div className="cw-rz cw-rz-ne" onPointerDown={startResize('ne')} />
      <div className="cw-rz cw-rz-nw" onPointerDown={startResize('nw')} />
    </div>
  );
}
