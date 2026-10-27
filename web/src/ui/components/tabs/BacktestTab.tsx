/** Backtest: the simulation against the official result of a real Paris vote, by sector. */
import { useState } from 'react';
import type { BacktestSector } from '../../../types';
import { useApp } from '../../context';
import { niceDate, pct, pct2, pts } from '../../format';
import { Seg, useTooltip } from '../common';

export function BacktestTab() {
  const { scenario, afterTalk, overlay, setOverlay } = useApp();
  const [yView, setYView] = useState<'attendees' | 'everyone'>('attendees');
  const tip = useTooltip();
  const bt = scenario?.backtest;
  if (!scenario || !bt) return null;
  const after = scenario.backtestAfterTalk;
  const useAfter = afterTalk && after;
  const sectors = useAfter ? after.bySector : bt.bySector;
  const metrics = useAfter ? after.metrics : bt.metrics;
  const sim = useAfter ? after.simulated : bt.simulated;

  const markers = [
    { key: 'actual', label: 'Official vote', value: bt.actual.yesShare, shape: 'diamond' as const },
    { key: 'att', label: 'Simulated likely voters', value: sim.attendeesYes, shape: 'square' as const },
    { key: 'all', label: 'Simulated, all Paris residents', value: sim.everyoneYes, shape: 'hollow' as const },
    ...(bt.poll ? [{ key: 'poll', label: `Poll (${bt.poll.org})`, value: bt.poll.yesShare, shape: 'circle' as const }] : []),
  ].filter((m) => Number.isFinite(m.value));

  const maeBefore = bt.metrics.sectorMae;
  const maeAfter = after?.metrics.sectorMae;
  const talkVerdict =
    maeAfter === undefined
      ? null
      : maeAfter < maeBefore - 0.005
        ? 'Talking made the simulation more accurate.'
        : maeAfter > maeBefore + 0.005
          ? 'Talking made the simulation less accurate.'
          : 'Talking barely changed accuracy.';

  return (
    <div>
      <div className="section">
        <h4 className="bt-title">{bt.voteName}</h4>
        <p className="small muted">
          {niceDate(bt.date)} · turnout {pct2(bt.actual.turnout)}
        </p>
        <blockquote className="quote" lang="fr">
          “{bt.question || scenario.proposalFr}”
        </blockquote>
      </div>

      <div className="section">
        <h3>City-wide: share “pour”</h3>
        <div className="big-compare" role="img" aria-label={markers.map((m) => `${m.label} ${pct(m.value)}`).join(', ')}>
          <div className="axis" />
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <span key={t} className="tick" style={{ left: `${t * 100}%` }}>
              {pct(t)}
            </span>
          ))}
          {markers.map((m) => (
            <Marker key={m.key} shape={m.shape} left={m.value} />
          ))}
        </div>
        <div className="marker-list">
          {markers.map((m) => (
            <div key={m.key} className="row-between small">
              <span className="row">
                <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
                  <MarkerShape shape={m.shape} />
                </svg>
                {m.label}
              </span>
              <b className="num">{m.key === 'actual' ? pct2(m.value) : pct(m.value)}</b>
            </div>
          ))}
        </div>
        {bt.poll ? (
          <p className="section-note">
            Poll vs vote: {pts(bt.actual.yesShare - bt.poll.yesShare)}. Simulation, likely voters vs everyone: {pts(sim.attendeesYes - sim.everyoneYes)}.{' '}
            {bt.metrics.gapSignCorrect === undefined ? '' : bt.metrics.gapSignCorrect ? 'Same direction: the turnout model explains part of the gap.' : 'Opposite direction.'}
            {bt.poll.note ? ` ${bt.poll.note}` : ''}
          </p>
        ) : null}
      </div>

      <div className="section">
        <div className="metric-grid">
          <div className="metric">
            <div className="m-value num">{(metrics.sectorMae * 100).toFixed(1)} pts</div>
            <div className="m-label">Average error by sector (likely voters)</div>
          </div>
          <div className="metric">
            <div className="m-value num">r = {metrics.sectorCorrelation.toFixed(2)}</div>
            <div className="m-label">Do high and low sectors line up? (1 = perfectly)</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="row-between wrap">
          <h3>By sector</h3>
          <Seg
            label="Simulated values"
            value={yView}
            onChange={setYView}
            options={[
              { value: 'attendees', label: 'Likely voters' },
              { value: 'everyone', label: 'Everyone' },
            ]}
          />
        </div>
        <Scatter sectors={sectors} yView={yView} tip={tip} />
        <div className="row-between wrap tab-tools">
          <span className="small muted">Colour the map</span>
          <Seg
            label="Colour the map"
            value={overlay === 'backtest_actual' || overlay === 'backtest_sim' ? overlay : 'none'}
            onChange={(v) => setOverlay(v)}
            options={[
              { value: 'none', label: 'Off' },
              { value: 'backtest_actual', label: 'Official' },
              { value: 'backtest_sim', label: 'Simulated' },
            ]}
          />
        </div>
      </div>

      {after && maeAfter !== undefined ? (
        <div className="section">
          <h3>Does talking help?</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th />
                <th className="r">Before talk</th>
                <th className="r">After talk</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Likely voters, city-wide</td>
                <td className="r">{pct(bt.simulated.attendeesYes)}</td>
                <td className="r">{pct(after.simulated.attendeesYes)}</td>
              </tr>
              <tr>
                <td>Average sector error</td>
                <td className="r">{(maeBefore * 100).toFixed(1)} pts</td>
                <td className="r">{(maeAfter * 100).toFixed(1)} pts</td>
              </tr>
              <tr>
                <td>Correlation r</td>
                <td className="r">{bt.metrics.sectorCorrelation.toFixed(2)}</td>
                <td className="r">{after.metrics.sectorCorrelation.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small after-table">
            <b>{talkVerdict}</b> Official result: {pct2(bt.actual.yesShare)}.
          </p>
        </div>
      ) : null}

      {bt.baselines.length ? (
        <div className="section">
          <h3>Simple baselines to beat</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>Baseline</th>
                <th className="r">“Pour”</th>
                <th className="r">Sector error</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <b>This simulation</b> (likely voters)
                </td>
                <td className="r">{pct(bt.simulated.attendeesYes)}</td>
                <td className="r">{(bt.metrics.sectorMae * 100).toFixed(1)} pts</td>
              </tr>
              {bt.baselines.map((b) => (
                <tr key={b.name}>
                  <td>
                    {b.name}
                    <div className="muted small">{b.description}</div>
                  </td>
                  <td className="r">{Number.isFinite(b.yesShare) ? pct(b.yesShare) : 'pending'}</td>
                  <td className="r">{b.sectorMae !== undefined && Number.isFinite(b.sectorMae) ? `${(b.sectorMae * 100).toFixed(1)} pts` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="section">
        <div className="callout">
          <h3>Leakage check: does the model remember the result?</h3>
          {bt.leakage.probed ? (
            <>
              <p className="small">
                <b>Bare model’s answer:</b> “{bt.leakage.bareModelAnswer ?? '–'}”
              </p>
              {bt.leakage.verdict ? (
                <p className="small">
                  <b>Verdict:</b> {bt.leakage.verdict}
                </p>
              ) : null}
            </>
          ) : (
            <p className="small">
              <b>Probe not run yet.</b> It needs the API key.
            </p>
          )}
          <p className="section-note">{bt.leakage.notes}</p>
        </div>
      </div>

      <div className="section">
        <p className="section-note">
          Sources:{' '}
          {bt.sources.map((s, i) => (
            <span key={s.name}>
              {i > 0 ? ', ' : ''}
              {s.url ? <a href={s.url}>{s.name}</a> : s.name}
            </span>
          ))}
          . Paris Centre = 1st to 4th arrondissements.
        </p>
      </div>
      {tip.node}
    </div>
  );
}

type Shape = 'diamond' | 'square' | 'hollow' | 'circle';

function MarkerShape({ shape }: { shape: Shape }) {
  if (shape === 'diamond') return <path d="M10 1l9 9-9 9-9-9z" fill="#2A1A0E" stroke="#FCF4DF" strokeWidth="2" />;
  if (shape === 'square') return <rect x="2" y="2" width="16" height="16" fill="#E3A72F" stroke="#3B2313" strokeWidth="3" />;
  if (shape === 'hollow') return <rect x="3" y="3" width="14" height="14" fill="#FCF4DF" stroke="#3B2313" strokeWidth="3" />;
  return <circle cx="10" cy="10" r="7" fill="#FCF4DF" stroke="#2F6FA8" strokeWidth="3" />;
}

function Marker({ shape, left }: { shape: Shape; left: number }) {
  return (
    <svg className="marker" style={{ left: `${left * 100}%` }} viewBox="0 0 20 20" aria-hidden="true">
      <MarkerShape shape={shape} />
    </svg>
  );
}

function Scatter({ sectors, yView, tip }: { sectors: BacktestSector[]; yView: 'attendees' | 'everyone'; tip: ReturnType<typeof useTooltip> }) {
  const W = 320;
  const H = 230;
  const pad = { l: 48, r: 10, t: 10, b: 34 };
  const ys = sectors.map((s) => (yView === 'attendees' ? s.simAttendeesYes : s.simEveryoneYes));
  const xs = sectors.map((s) => s.actualYes);
  const all = [...xs, ...ys].filter(Number.isFinite);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.03) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...all) + 0.03) * 20) / 20);
  const sx = (v: number) => pad.l + ((v - lo) / (hi - lo || 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg className="scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Official share per sector against simulated share per sector">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={pad.t} y2={H - pad.b} stroke="rgba(110,69,36,0.15)" />
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="rgba(110,69,36,0.15)" />
          <text x={sx(t)} y={H - pad.b + 14} textAnchor="middle">
            {pct(t)}
          </text>
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end">
            {pct(t)}
          </text>
        </g>
      ))}
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="#6E4524" strokeDasharray="4 4" strokeWidth="1.5" />
      <text x={sx(hi) - 4} y={sy(hi) + 14} textAnchor="end">
        perfect
      </text>
      <text x={(W + pad.l) / 2} y={H - 4} textAnchor="middle">
        Official “pour” by sector
      </text>
      <text x={10} y={(H - pad.b) / 2} textAnchor="middle" transform={`rotate(-90 10 ${(H - pad.b) / 2})`}>
        Simulated
      </text>
      {sectors.map((s, i) => {
        const y = ys[i];
        if (!Number.isFinite(y)) return null;
        const label = `${s.sector}: official ${pct(s.actualYes)}, simulated ${pct(y)}`;
        return (
          <g key={s.sector} onMouseMove={(e) => tip.show(e, label)} onMouseLeave={tip.hide}>
            <rect x={sx(s.actualYes) - 9} y={sy(y) - 9} width="18" height="18" fill="transparent" />
            <rect x={sx(s.actualYes) - 4} y={sy(y) - 4} width="8" height="8" fill={yView === 'attendees' ? '#E3A72F' : '#FCF4DF'} stroke="#3B2313" strokeWidth="2">
              <title>{label}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
