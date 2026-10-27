/** Overview: support / oppose per view (with ranges), how many people the proposal touches, top reasons. */
import { useMemo } from 'react';
import type { ViewMode } from '../../../types';
import { useApp } from '../../context';
import { int, pct } from '../../format';
import { Icon } from '../../icons';
import { EXPOSURE_LEVEL, viewLabel } from '../../labels';
import { ComputedChip, Num, StanceBar, StanceLegend, VoiceChip, YesValue } from '../common';

const VIEW_ICON: Record<ViewMode, string> = { everyone: 'people', eligible: 'ballot', attendees: 'walk' };

export function OverviewTab() {
  const { scenario, views, view, setView, openTab, afterTalk } = useApp();
  const exposureCounts = useMemo(() => {
    const c = [0, 0, 0, 0];
    for (const r of scenario?.results ?? []) c[r.exposure.score]++;
    return c;
  }, [scenario]);
  if (!scenario || !views) return null;
  const total = exposureCounts.reduce((s, x) => s + x, 0) || 1;
  const topThemes = scenario.themes.slice().sort((a, b) => b.share - a.share).slice(0, 3);
  const topMiss = scenario.consult[0];

  return (
    <div>
      <div className="section">
        <div className="row-between">
          <h3>How the town reacts{afterTalk ? ' (after talking)' : ''}</h3>
        </div>
        <StanceLegend />
        <div style={{ marginTop: 6 }}>
          {(['everyone', 'eligible', 'attendees'] as ViewMode[]).map((v) => (
            <button key={v} type="button" className="view-row" aria-pressed={view === v} onClick={() => setView(v)}>
              <span className="vr-label">
                <Icon name={VIEW_ICON[v]} size={16} />
                {viewLabel(v, scenario.voterScope)}
                <span className="muted small">
                  (<Num value={views[v].n} format={int} />)
                </span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <YesValue agg={views[v]} />
              </span>
              <StanceBar agg={views[v]} />
              <span className="small muted" style={{ gridColumn: '1 / -1' }}>
                <Num value={views[v].oppose} format={(n) => pct(n)} /> against · <Num value={views[v].neutral} format={(n) => pct(n)} /> undecided ·{' '}
                <Num value={views[v].support} format={(n) => pct(n)} /> in favour
              </span>
            </button>
          ))}
        </div>
        <p className="section-note">Big number = share in favour among those with an opinion (comparable with a “pour” vote).</p>
      </div>

      <div className="section">
        <h3>
          What changes for people <ComputedChip />
        </h3>
        <div className="exposure-bar" role="img" aria-label={exposureCounts.map((c, i) => `${EXPOSURE_LEVEL[i]}: ${c}`).join(', ')}>
          {exposureCounts.map((c, i) => (
            <span key={i} className={`exp-${i}`} style={{ flexGrow: Math.max(0.0001, c / total) }} title={`${EXPOSURE_LEVEL[i]}: ${int(c)} residents`}>
              {c / total > 0.09 ? int(c) : ''}
            </span>
          ))}
        </div>
        <div className="legend" style={{ marginTop: 6 }}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i}>
              <i className={`exp-${i}`} />
              {EXPOSURE_LEVEL[i]}
            </span>
          ))}
        </div>
        <p className="section-note">From where each resident lives and works and their situation. The AI does not decide this.</p>
      </div>

      {topThemes.length ? (
        <div className="section">
          <h3>
            Main reasons <VoiceChip />
          </h3>
          {topThemes.map((t) => (
            <div key={t.id} className="row-between small" style={{ padding: '3px 0' }}>
              <span className="row" style={{ gap: 6 }}>
                <i className={t.side === 'support' ? 'sw-support' : t.side === 'oppose' ? 'sw-oppose' : 'sw-neutral'} style={{ width: 10, height: 10, display: 'inline-block' }} />
                {t.label}
              </span>
              <span className="num">{pct(t.share)}</span>
            </div>
          ))}
          <button type="button" className="link-btn small" onClick={() => openTab('themes')}>
            See all themes and quotes
          </button>
        </div>
      ) : null}

      {topMiss ? (
        <div className="section">
          <div className="card callout">
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="ghost" size={22} />
              <div>
                <strong>Voices you would miss:</strong> {topMiss.label.toLowerCase()} are touched by this ({topMiss.meanExposure.toFixed(1)} / 3) but count for only{' '}
                {topMiss.representationRatio.toFixed(1)}× their share among likely participants.{' '}
                <button type="button" className="link-btn" onClick={() => openTab('consult')}>
                  Plan outreach
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
