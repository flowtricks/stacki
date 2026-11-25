// The `/` menu above the composer: Stacki's commands, the active agent's skills and the agent's own
// commands, each row an icon, the name, a one-line description and, for a skill, whether it is the
// project's or the person's own. The editor keeps focus throughout (a press on a row is stopped from
// taking it), so the highlight is controlled by the input, which routes the arrow keys, Enter, Tab and
// Esc here through `pickerKeymap`. While the skill list has never been read for this project the
// menu draws placeholder rows under the commands; when nothing matches it shows the empty-state card.
import { useEffect, useRef } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { SKILL_PLACES, skillPlacePrefix } from '../../../../shared/properties/ai/skillPlaces';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { EmptyState } from '../../../ui/EmptyState';
import { SkillIcon, SparkleIcon, TerminalIcon } from '../../../ui/Icons';
import { Skeleton, SkeletonRows } from '../../../ui/Skeleton';
import { slashRowName, type SlashRow } from './slashRows';
import type { SlashSkillState } from './useSlashSkills';

export interface SlashMenuProps {
  readonly agent: AgentId;
  readonly rows: readonly SlashRow[];
  readonly activeIndex: number;
  readonly skills: SlashSkillState;
  readonly onActiveChange: (index: number) => void;
  readonly onChoose: (row: SlashRow) => void;
}

/** Placeholder rows drawn while the skill list is first read. */
const LOADING_ROWS = 3;

export function SlashMenu(props: SlashMenuProps) {
  assert(props.activeIndex >= 0, 'SlashMenu: the active row is not negative');
  assert(props.rows.length === 0 || props.activeIndex < props.rows.length, 'SlashMenu: the active row is a row');
  const translate = useTranslate();
  const list = useRef<HTMLDivElement>(null);
  // The highlighted row stays in view as the arrows move it through a list longer than the menu.
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row !== null && row !== undefined && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [props.activeIndex, props.rows.length]);
  const loading = props.skills.kind === 'loading';
  if (props.rows.length === 0 && !loading) {
    return (
      <div className="ai-commands ai-commands-empty">
        <EmptyState
          icon={<SkillIcon size={18} />}
          title={translate('ai.composer.slash.none')}
          description={
            props.skills.kind === 'failed'
              ? translate('ai.composer.slash.failed')
              : translate('ai.composer.slash.noneHint', { folder: skillFolderOf(props.agent) })
          }
        />
      </div>
    );
  }
  return (
    <div ref={list} className="ai-commands" role="listbox" aria-label={translate('ai.composer.add.commands')} aria-busy={loading}>
      {props.rows.map((row, index) => (
        <button
          key={`${row.kind}:${slashRowName(row)}`}
          type="button"
          role="option"
          aria-selected={index === props.activeIndex}
          className={index === props.activeIndex ? 'ai-command on' : 'ai-command'}
          title={row.kind === 'skill' ? row.skill.path : undefined}
          onMouseEnter={() => props.onActiveChange(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            props.onChoose(row);
          }}
        >
          <span className="ai-command-icon" aria-hidden="true">
            {rowIcon(row)}
          </span>
          <span className="ai-command-text">
            <span className="ai-command-name" dir="ltr">
              /{slashRowName(row)}
            </span>
            {rowDescription(row) !== '' && <span className="ai-command-description">{rowDescription(row)}</span>}
          </span>
          {row.kind === 'skill' && (
            <span className="ai-command-source">
              {row.skill.source === 'project' ? translate('ai.composer.slash.source.project') : translate('ai.composer.slash.source.user')}
            </span>
          )}
        </button>
      ))}
      {loading && (
        <SkeletonRows
          count={LOADING_ROWS}
          row={(widthPercent) => (
            <span className="ai-command ai-command-skeleton">
              <Skeleton width="14px" height="14px" />
              <Skeleton width={`${widthPercent}%`} />
            </span>
          )}
        />
      )}
    </div>
  );
}

function rowIcon(row: SlashRow) {
  switch (row.kind) {
    case 'builtin':
      return <SparkleIcon size={14} />;
    case 'command':
      return <TerminalIcon size={14} />;
    case 'skill':
      return <SkillIcon size={14} />;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function rowDescription(row: SlashRow): string {
  switch (row.kind) {
    case 'builtin':
    case 'command':
      return row.command.description;
    case 'skill':
      return row.skill.description;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

/** Where the agent's project skills live, for the empty state's hint. */
function skillFolderOf(agent: AgentId): string {
  const place = SKILL_PLACES.find((candidate) => candidate.agent === agent && candidate.base === 'project');
  assert(place !== undefined, 'skillFolderOf: every agent has a project skill folder');
  return skillPlacePrefix(place);
}
