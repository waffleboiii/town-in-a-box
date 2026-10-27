/** Left panel: the decision being tested, exactly as the simulated residents read it. */
import { useState } from 'react';
import type { Scenario } from '../../types';
import { districtName, useApp } from '../context';
import { metres, niceDate, pct, pct2 } from '../format';
import { CHANNEL_SHORT, KIND_BADGE } from '../labels';
import { Icon } from '../icons';
import { LangToggle } from './common';

export function ProposalPanel({ scenario, collapsed, onToggle }: { scenario: Scenario; collapsed: boolean; onToggle: () => void }) {
  const { districtsByIdx, focusDistrict, map, data } = useApp();
  const [lang, setLang] = useState<'en' | 'fr'>('en');
  const [expanded, setExpanded] = useState(false);
  const text = lang === 'en' ? scenario.proposalEn : scenario.proposalFr;
  const isBacktest = scenario.kind === 'backtest';
  return (
    <section className="panel side-panel proposal" aria-labelledby="proposal-title">
      <div className="panel-head">
        <div className="head-text">
          <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
            <span className="badge-kind" data-kind={scenario.kind}>
              {KIND_BADGE[scenario.kind]}
            </span>
            {scenario.date ? <span className="chip">{niceDate(scenario.date)}</span> : null}
          </div>
          <h2 id="proposal-title">{scenario.title}</h2>
          {!collapsed ? <p className="panel-sub">{scenario.summary}</p> : null}
        </div>
        <button type="button" className="btn btn-icon btn-small" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Show the proposal' : 'Hide the proposal'}>
          <Icon name={collapsed ? 'right' : 'left'} size={14} style={{ transform: 'rotate(90deg)' }} />
        </button>
      </div>
      {!collapsed ? (
        <div className="panel-body">
          <div className="section">
            <div className="row-between">
              <h3>
                <Icon name="info" size={16} /> {isBacktest ? 'The official question' : 'What residents read'}
              </h3>
              <LangToggle lang={lang} onChange={setLang} />
            </div>
            <div className={`card proposal-text ${expanded ? '' : 'clamped'}`} lang={lang}>
              <span>{text}</span>
            </div>
            {text.length > 220 ? (
              <button type="button" className="link-btn small" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Show less' : 'Read all'}
              </button>
            ) : null}
            {lang === 'en' ? <p className="section-note">Residents read the French text. English is a translation.</p> : null}
          </div>

          <div className="section facts-compact">
            {scenario.site ? (
              <div className="f-wide">
                <div className="f-label">Site</div>
                <button type="button" className="link-btn" onClick={() => map?.focus(scenario.site!.x + 0.5, scenario.site!.y + 0.5, 1.4, true)}>
                  {scenario.site.label}
                </button>{' '}
                <span className="muted">rings at {scenario.site.ringsTiles.map((r) => metres(r * data.map.tileMeters)).join(', ')}</span>
              </div>
            ) : null}
            <div>
              <div className="f-label">Channel</div>
              {CHANNEL_SHORT[scenario.channel]}
            </div>
            <div>
              <div className="f-label">Turnout</div>
              {isBacktest ? pct2(scenario.turnoutTarget) : pct(scenario.turnoutTarget, 1)} <span className="muted">{isBacktest ? 'real' : 'assumed'}</span>
            </div>
            <div className="f-wide">
              <div className="f-label">Who can take part</div>
              {scenario.voterScope === 'paris_eligible' ? (
                <>
                  Paris residents who can vote <span className="chip chip-imputed">nationality imputed</span>
                </>
              ) : (
                'Every adult resident'
              )}
            </div>
            {scenario.zoneDistricts?.length ? (
              <div className="f-wide">
                <div className="f-label">Area</div>
                <div className="row wrap" style={{ gap: 4 }}>
                  {scenario.zoneDistricts.map((d) => (
                    <button key={d} type="button" className="chip chip-btn" onClick={() => focusDistrict(d)}>
                      {districtName(districtsByIdx, d)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="f-wide">
              <div className="f-label">Reactions by</div>
              {scenario.mock ? 'demo heuristics (no AI yet)' : scenario.models.reaction}
            </div>
          </div>
          {scenario.notes?.length ? (
            <div className="section">
              {scenario.notes.map((n) => (
                <p key={n} className="section-note">
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
