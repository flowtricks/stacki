import React from 'react';
import { gitBranchColor } from '../../lib/gitBranchColors';
import type { HistoryGraphEdge, HistoryGraphRow } from './historyGraph';

export const HISTORY_ROW_HEIGHT = 46;
const NODE_Y = 17;
const LANE_WIDTH = 14;

export function historyGraphWidth(lanes: number): number {
  return lanes * LANE_WIDTH + 12;
}

export default function HistoryGraphLane({ row, width, current }: { readonly row: HistoryGraphRow; readonly width: number; readonly current: boolean }) {
  const pixels = historyGraphWidth(width);
  return (
    <div className="history-graph-lane" aria-hidden="true">
      <svg width={pixels} height={HISTORY_ROW_HEIGHT} className="history-graph-drawing">
        {row.edges.map((edge, index) => (
          <path key={index} d={historyGraphPath(edge)} style={{ color: gitBranchColor(edge.color) }} className={`history-graph-color-${edge.color}`} />
        ))}
        <circle
          cx={laneX(row.lane)}
          cy={NODE_Y}
          r={current ? 5 : 3.5}
          style={{ color: gitBranchColor(row.color) }}
          className={`history-graph-node history-graph-color-${row.color}`}
        />
        {current && <circle cx={laneX(row.lane)} cy={NODE_Y} r={2} className="history-head-dot" />}
      </svg>
      <svg
        className="history-graph-extension"
        style={{ top: HISTORY_ROW_HEIGHT, height: `calc(100% - ${HISTORY_ROW_HEIGHT}px)` }}
        width={pixels}
        viewBox={`0 0 ${pixels} 1`}
        preserveAspectRatio="none"
      >
        {row.continuing.map(({ lane, color }) => (
          <path
            key={lane}
            d={`M ${laneX(lane)} 0 V 1`}
            vectorEffect="non-scaling-stroke"
            style={{ color: gitBranchColor(color) }}
            className={`history-graph-color-${color}`}
          />
        ))}
      </svg>
    </div>
  );
}

function laneX(lane: number): number {
  return 12 + lane * LANE_WIDTH;
}

function historyGraphPath(edge: HistoryGraphEdge): string {
  const source = laneX(edge.source);
  const target = laneX(edge.target);
  if (edge.kind === 'incoming') {
    return `M ${source} 0 V ${NODE_Y}`;
  }
  if (edge.kind === 'through') {
    return `M ${source} 0 V ${HISTORY_ROW_HEIGHT}`;
  }
  if (source === target) {
    return `M ${source} ${NODE_Y} V ${HISTORY_ROW_HEIGHT}`;
  }
  return `M ${source} ${NODE_Y} C ${source} 32 ${target} 28 ${target} ${HISTORY_ROW_HEIGHT}`;
}
