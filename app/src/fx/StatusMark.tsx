// Adapted from React Bits (https://github.com/DavidHDev/react-bits), src/ts-default/Micro/StatusMark/StatusMark.tsx
// at commit 9d9c687dc4f55b23539aa5417b703078047efa74. Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0:
// see LICENSES/react-bits.txt. Modified by Tender contributors: no motion/react dependency (the ring's dash pattern is
// set from the status and moved by a CSS transition, the running arc spins with one CSS keyframe), no determinate
// progress, no strike-through by default, and a labelled mark does not repeat its status in hidden text (the label says it).

import type { CSSProperties, ReactNode } from 'react';

import './StatusMark.css';

export type StatusMarkStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface StatusMarkProps {
  status?: StatusMarkStatus;
  label?: ReactNode;
  color?: string;
  doneColor?: string;
  errorColor?: string;
  size?: number;
  strokeWidth?: number;
  dashes?: number;
  fontSize?: number;
  spinDuration?: number;
  arcLength?: number;
  drawDuration?: number;
  fillOpacity?: number;
  strike?: boolean;
  strikeDelay?: number;
  className?: string;
  style?: CSSProperties;
}

const TEXT: Record<StatusMarkStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const IDLE_DASH = 0.3;

const StatusMark = ({
  status = 'pending',
  label,
  color = 'currentColor',
  doneColor = 'var(--ok)',
  errorColor = 'var(--bad)',
  size = 20,
  strokeWidth = 2,
  dashes = 8,
  fontSize = 14,
  spinDuration = 1100,
  arcLength = 0.68,
  drawDuration = 240,
  fillOpacity = 0.06,
  strike = false,
  strikeDelay = 60,
  className = '',
  style,
}: StatusMarkProps) => {
  const r = 10 - strokeWidth / 2;
  const C = 2 * Math.PI * r;
  const P = C / Math.max(1, dashes);
  const indeterminate = status === 'running';
  const solid = status === 'running' || status === 'done' || status === 'failed';
  const arc = indeterminate ? arcLength : 1;
  // The same dash pattern React Bits interpolates with motion values, at its two ends: dashed ring (idle) or one arc (solid).
  const dash = solid ? arc * C : IDLE_DASH * P;
  const gap = solid ? (1 - arc) * C : (1 - IDLE_DASH) * P;
  const hasLabel = label !== undefined && label !== null;

  return (
    <span
      className={`status-mark${className ? ` ${className}` : ''}`}
      data-status={status}
      data-indeterminate={indeterminate ? '' : undefined}
      data-strike={strike ? '' : undefined}
      style={
        {
          '--sm-size': `${size}px`,
          '--sm-stroke': strokeWidth,
          '--sm-color': color,
          '--sm-done': doneColor,
          '--sm-error': errorColor,
          '--sm-fill': fillOpacity,
          '--sm-font': `${fontSize}px`,
          '--sm-draw': `${drawDuration}ms`,
          '--sm-spin': `${spinDuration}ms`,
          '--sm-strike-delay': `${120 + strikeDelay}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <svg
        className="status-mark__glyph"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role={hasLabel ? undefined : 'img'}
        aria-label={hasLabel ? undefined : TEXT[status]}
        aria-hidden={hasLabel || undefined}
      >
        <circle className="status-mark__track" cx="12" cy="12" r={r} transform="rotate(-90 12 12)" />
        <g className="status-mark__spin">
          <circle
            className="status-mark__ring"
            cx="12"
            cy="12"
            r={r}
            transform="rotate(-90 12 12)"
            style={{ strokeDasharray: `${Math.max(0, dash).toFixed(3)} ${Math.max(0, gap).toFixed(3)}` }}
          />
        </g>
        <path className="status-mark__check" d="M7.5 12.25 10.5 15.25 16.75 8.75" pathLength={1} />
        <path className="status-mark__cross" d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" pathLength={1} />
      </svg>
      {hasLabel ? (
        <span className="status-mark__label">
          {label}
          <span className="status-mark__strike" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
};

export default StatusMark;
