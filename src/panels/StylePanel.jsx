import React, { useEffect, useRef, useState } from 'react';
import EmbedEditor from '../style-panel/EmbedEditor.tsx';
import { setHost } from '../style-panel/lib/host.ts';
// The panel's stylesheet is written against moden's design tokens, so they
// come with it.
import '../style-panel/tokens.css';
import '../style-panel/utilities.css';
import '../style-panel/embed-editor.css';

// Host for the style panel.
//
// The panel itself is moden's, unchanged. This supplies the app state it reads
// through lib/host.ts, and lib/webflow.ts answers its questions from that: the
// selected node instead of a Designer element, and the project's stylesheets
// plus the page's <style> blocks instead of Webflow embeds.
//
// Choosing which of those to author into is the panel's own "Add custom styles
// in:" control — the same one it has always had, now listing project sources.

export default function StylePanel({
  project,
  model,
  node,
  device,
  onWriteStyleNode,
  onSelectNode,
  onRecordUndo,
  renderedClasses,
}) {
  const [files, setFiles] = useState([]);

  useEffect(() => {
    let live = true;
    if (!project?.path) return undefined;
    window.avb
      .listStyleFiles(project.path)
      .then((r) => live && setFiles(r?.files || []))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [project?.path]);

  // Set during render, not in an effect: React runs a child's effects before
  // its parent's, so EmbedEditor would read an empty bridge on mount and
  // settle on "No element selected". setHost only notifies on real changes,
  // so calling it every render is cheap.
  setHost({
    projectPath: project?.path || null,
    nodes: model?.nodes || [],
    selectedId: node?.id || null,
    device: device || 'desktop',
    files,
    writeStyleNode: onWriteStyleNode || null,
    selectNode: onSelectNode || null,
    recordUndo: onRecordUndo || null,
    renderedClasses: renderedClasses || [],
  });

  useEffect(() => {
    setHost({
      projectPath: project?.path || null,
      nodes: model?.nodes || [],
      selectedId: node?.id || null,
      device: device || 'desktop',
      files,
      writeStyleNode: onWriteStyleNode || null,
      selectNode: onSelectNode || null,
      recordUndo: onRecordUndo || null,
      renderedClasses: renderedClasses || [],
    });
  }, [project?.path, model, node?.id, device, files, onWriteStyleNode, onSelectNode, onRecordUndo, renderedClasses]);

  // The panel's popups (clip path, transitions, background, grid) are portaled
  // to <body> and were written for moden, where the panel filled the window —
  // so their backdrop spans the viewport and the sheets size to it. Publish
  // this panel's box so they can be bound to it instead; see styles.css.
  const hostRef = useRef(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const publish = () => {
      const r = el.getBoundingClientRect();
      const root = document.documentElement.style;
      root.setProperty('--style-panel-left', `${r.left}px`);
      root.setProperty('--style-panel-top', `${r.top}px`);
      root.setProperty('--style-panel-width', `${r.width}px`);
      root.setProperty('--style-panel-height', `${r.height}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, []);

  if (!project) return null;

  return (
    <div className="style-panel-host" ref={hostRef}>
      {!node ? (
        <div className="props-empty">Select an element to style it.</div>
      ) : (
        <EmbedEditor />
      )}
    </div>
  );
}
