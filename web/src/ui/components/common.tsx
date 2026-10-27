/** Small building blocks shared by the panels. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewAgg } from '../../types';
import { pct } from '../format';
import { useTween } from '../hooks';
import { Icon } from '../icons';

/** An animated number: glides to its new value when it changes. */
export function Num({ value, format, ms = 600 }: { value: number; format: (n: number) => string; ms?: number }) {
  const v = useTween(value, ms);
  return <span className="num">{format(v)}</span>;
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LangToggle({ lang, onChange }: { lang: 'en' | 'fr'; onChange: (l: 'en' | 'fr') => void }) {
  return (
    <Seg
      label="Language"
      value={lang}
      onChange={onChange}
      options={[
        { value: 'en', label: 'EN' },
        { value: 'fr', label: 'FR' },
      ]}
    />
  );
}

export function ImputedChip({ title }: { title?: string }) {
  return (
    <span className="chip chip-imputed" title={title ?? 'Not in the NVIDIA dataset: estimated from INSEE statistics'}>
      imputed
    </span>
  );
}

export function ComputedChip({ children = 'computed, not AI' }: { children?: ReactNode }) {
  return <span className="chip chip-computed">{children}</span>;
}

export function VoiceChip() {
  return (
    <span className="chip chip-voice" title="Written by an AI model playing this simulated resident. Not a real person.">
      <Icon name="chat" size={13} /> simulated voice
    </span>
  );
}

export function Pips({ value, max = 3, label }: { value: number; max?: number; label?: string }) {
  return (
    <span className="pips" role="img" aria-label={label ?? `${value} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < Math.round(value) ? 'on' : ''} />
      ))}
    </span>
  );
}

/** Oppose | undecided | support stacked bar, with 2px gaps between segments. */
export function StanceBar({ agg }: { agg: ViewAgg }) {
  return (
    <div className="stance-bar" aria-hidden="true">
      <span className="sb-oppose" style={{ flexGrow: Math.max(0.0001, agg.oppose) }} />
      <span className="sb-neutral" style={{ flexGrow: Math.max(0.0001, agg.neutral) }} />
      <span className="sb-support" style={{ flexGrow: Math.max(0.0001, agg.support) }} />
    </div>
  );
}

export function StanceLegend() {
  return (
    <div className="legend">
      <span>
        <i className="sw-oppose" />
        Against
      </span>
      <span>
        <i className="sw-neutral" />
        Undecided
      </span>
      <span>
        <i className="sw-support" />
        In favour
      </span>
    </div>
  );
}

/** Accessible modal: traps nothing fancy, but focuses itself and closes on backdrop click. */
export function Modal({ onClose, labelledBy, children, className = 'modal' }: { onClose: () => void; labelledBy: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`panel ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

/** Hover tooltip for SVG charts (follows the pointer). */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const node = tip ? (
    <div className="tooltip" style={{ left: tip.x + 14, top: tip.y - 10 }} role="tooltip">
      {tip.text}
    </div>
  ) : null;
  return { node, show: (e: { clientX: number; clientY: number }, text: string) => setTip({ x: e.clientX, y: e.clientY, text }), hide: () => setTip(null) };
}

/** "52% in favour" with the uncertainty range underneath. */
export function YesValue({ agg }: { agg: ViewAgg }) {
  return (
    <>
      <span className="vr-value">
        <Num value={agg.yesShare} format={(n) => pct(n)} />
      </span>
      {agg.yesRange ? (
        <span className="vr-range">
          range {pct(agg.yesRange[0])}–{pct(agg.yesRange[1])}
        </span>
      ) : null}
    </>
  );
}
