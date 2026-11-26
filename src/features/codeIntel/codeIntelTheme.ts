// Code intelligence's tooltips wear the app's menu: the same rounded dark surface, shadow and row highlight
// (src/ui/menu.css). A theme rather than a stylesheet, and at the highest precedence, because CodeMirror's own tooltip
// rules ship as themes and only a theme reliably outranks them. Code in them reads left to right in every language.
import { Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const SURFACE = 'var(--menu-surface, var(--color-bg-surface-raised, #3b3b3b))';

export const codeIntelTheme = Prec.highest(
  EditorView.theme(
    {
      '.cm-tooltip': {
        backgroundColor: SURFACE,
        color: 'var(--text, #f5f5f5)',
        border: '0',
        borderRadius: '12px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35)',
        zIndex: '300',
      },
      '.cm-tooltip.cm-tooltip-autocomplete': { padding: '6px' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: 'var(--mono)',
        direction: 'ltr',
        maxHeight: '264px',
        minWidth: '260px',
        maxWidth: 'min(620px, calc(100vw - 32px))',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minHeight: '24px',
        padding: '2px 10px',
        borderRadius: '8px',
        lineHeight: '1.55',
      },
      '.cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(255, 255, 255, 0.13)', color: 'inherit' },
      '.cm-completionLabel': { whiteSpace: 'pre' },
      '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)' },
      '.code-intel-swatch': { flex: 'none', width: '10px', height: '10px', borderRadius: '3px' },
      '.code-intel-required': { marginInlineStart: '-6px', color: '#ff9b9b' },
      '.code-intel-aside': {
        display: 'flex',
        gap: '10px',
        justifyContent: 'flex-end',
        flex: '1 1 0',
        minWidth: '0',
        paddingInlineStart: '16px',
        color: 'var(--text-dim)',
      },
      '.code-intel-detail': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0' },
      '.code-intel-source': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0', color: 'var(--text-faint)' },
      '.cm-tooltip.cm-completionInfo': {
        padding: '10px 12px',
        width: 'max-content',
        maxWidth: '360px',
        maxHeight: '264px',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
      },
      '.code-intel-hover': {
        padding: '10px 12px',
        maxWidth: 'min(520px, calc(100vw - 32px))',
        maxHeight: '260px',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
      },
      '.code-intel-signature': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: 'left' }, // physical: code reads left to right
      '.code-intel-prose': {
        fontFamily: 'var(--font, system-ui, sans-serif)',
        fontSize: '12px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        color: 'var(--text-dim)',
      },
      '.code-intel-signature + .code-intel-prose': { marginTop: '8px' },
      '.code-intel-argument': { fontWeight: '700', textDecoration: 'underline', textUnderlineOffset: '3px' },
      '.cm-tooltip-hover > .cm-tooltip-section:not(:first-child)': { border: '0' },
      '.cm-tooltip-lint': { padding: '6px', maxWidth: 'min(520px, calc(100vw - 32px))', maxHeight: '260px', overflowY: 'auto', scrollbarGutter: 'stable' },
      '.cm-diagnostic': { padding: '4px 8px', border: '0', whiteSpace: 'pre-wrap' },
      '.cm-diagnostic::before': { content: '""', display: 'inline-block', width: '6px', height: '6px', marginInlineEnd: '8px', borderRadius: '50%' },
      '.cm-diagnostic-error::before': { backgroundColor: '#ff6b6b' },
      '.cm-diagnostic-warning::before': { backgroundColor: '#ffc857' },
      '.cm-diagnostic-info::before': { backgroundColor: '#82aaff' },
    },
    { dark: true },
  ),
);
