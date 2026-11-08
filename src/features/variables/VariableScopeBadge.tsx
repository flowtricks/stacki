import React from 'react';
import type { WireVariableScope } from '../../../shared/ipc/ipcResults';

// A `<style>` block's variables do not reach what a stylesheet's do, and a panel of
// names reads as if they all apply everywhere. The badge says who each one reaches.

export function variableScopeLabel(scope: WireVariableScope): string {
  switch (scope.reach) {
    case 'page':
      return 'This page';
    case 'rendered':
      return 'Where rendered';
    case 'scoped':
      return 'This file only';
    default: {
      const exhaustive: never = scope.reach;
      return exhaustive;
    }
  }
}

function reachDetail(reach: WireVariableScope['reach']): string {
  switch (reach) {
    case 'page':
      return 'Declared in a <style> on this page, so it applies on this page only.';
    case 'rendered':
      return 'Declared in a <style> in this file, so it applies only on pages that render it.';
    case 'scoped':
      return 'Astro scopes this <style>, so this rule reaches only the elements written in this file.';
    default: {
      const exhaustive: never = reach;
      return exhaustive;
    }
  }
}

function writtenDetail(written: WireVariableScope['written']): string {
  switch (written) {
    case 'global':
      return 'The block is is:global: Astro bundles it without scoping.';
    case 'inline':
      return 'The block is is:inline: Astro leaves it in the page exactly as written.';
    case 'scoped':
      return 'The block is a plain <style>: :root, html, body and :global() stay unscoped, every other selector is scoped.';
    default: {
      const exhaustive: never = written;
      return exhaustive;
    }
  }
}

export function variableScopeDetail(scope: WireVariableScope): string {
  return `${reachDetail(scope.reach)} ${writtenDetail(scope.written)}`;
}

export function VariableScopeBadge({ scope }: { readonly scope: WireVariableScope | undefined }) {
  if (scope === undefined) {
    return undefined;
  }
  return (
    <span className="vars-scope" title={variableScopeDetail(scope)}>
      {variableScopeLabel(scope)}
    </span>
  );
}
