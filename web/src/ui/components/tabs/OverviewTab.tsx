/** Overview: support / oppose per view (with ranges), how many people the proposal touches, top reasons. */
import { useMemo } from 'react';
import type { ViewMode } from '../../../types';
import { useApp } from '../../context';
import { int, pct } from '../../format';
import { Icon } from '../../icons';
import { EXPOSURE_LEVEL, viewLabel } from '../../labels';
import { ComputedChip, Num, SectionHead, StanceBar, StanceLegend, VoiceChip, YesValue } from '../common';

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
        <SectionHead aside={<StanceLegend />}>How the town reacts{afterTalk ? ' (after talking)' : ''}</SectionHead>
        <div className="view-rows">
          {(['everyone', 'eligible', 'attendees'] as ViewMode[]).map((v) => (
            <button key={v} type="button" className="view-row" aria-pressed={view === v} onClick={() => setView(v)}>
              <span className="vr-label">
                <Icon name={VIEW_ICON[v]} size={16} />
                {viewLabel(v, scenario.voterScope)}
                <span className="vr-n">
                  <Num value={views[v].n} format={int} />
                </span>
              </span>
              <span className="vr-right">
                <YesValue agg={views[v]} />
              </span>
              <StanceBar agg={views[v]} />
              {view === v ? (
                <span className="vr-split">
                  <span className="t-oppose">
                    <Num value={views[v].oppose} format={(n) => pct(n)} /> against
                  </span>
                  <span>
                    <Num value={views[v].neutral} format={(n) => pct(n)} /> undecided
                  </span>
                  <span className="t-support">
                    <Num value={views[v].support} format={(n) => pct(n)} /> in favour
                  </span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <p className="section-note">Big number: share in favour among those with an opinion, comparable with a “pour” vote.</p>
      </div>

      <div className="section">
        <SectionHead aside={<ComputedChip />}>What changes for people</SectionHead>
        <div className="exposure-bar" role="img" aria-label={exposureCounts.map((c, i) => `${EXPOSURE_LEVEL[i]}: ${c}`).join(', ')}>
          {exposureCounts.map((c, i) => (
            <span key={i} className={`exp-${i}`} style={{ flexGrow: Math.max(0.0001, c / total) }} title={`${EXPOSURE_LEVEL[i]}: ${int(c)} residents`}>
              {c / total > 0.09 ? int(c) : ''}
            </span>
          ))}
        </div>
        <div className="legend legend-below">
          {[0, 1, 2, 3].map((i) => (
            <span key={i}>
              <i className={`exp-${i}`} />
              {EXPOSURE_LEVEL[i]}
            </span>
          ))}
        </div>
      </div>

      {topThemes.length ? (
        <div className="section">
          <SectionHead aside={<VoiceChip />}>Main reasons</SectionHead>
          <ul className="reason-list">
            {topThemes.map((t) => (
              <li key={t.id}>
                <i className={t.side === 'support' ? 'sw-support' : t.side === 'oppose' ? 'sw-oppose' : 'sw-neutral'} aria-hidden="true" />
                <span className="rl-label">{t.label}</span>
                <span className="num">{pct(t.share)}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn small" onClick={() => openTab('themes')}>
            All themes and quotes
          </button>
        </div>
      ) : null}

      {topMiss ? (
        <div className="section">
          <div className="callout callout-miss">
            <Icon name="ghost" size={22} />
            <div>
              <b>Voices you would miss</b>
              <p>
                {topMiss.impactShare !== undefined && topMiss.voiceShare !== undefined
                  ? `${topMiss.label}: ${pct(topMiss.impactShare)} of the impact, but ${pct(topMiss.voiceShare)} of the likely participants.`
                  : `${topMiss.label} are touched by this (${topMiss.meanExposure.toFixed(1)} / 3) but count for only ${topMiss.representationRatio.toFixed(1)}× their share among likely participants.`}{' '}
                <button type="button" className="link-btn" onClick={() => openTab('consult')}>
                  Plan outreach
                </button>
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
