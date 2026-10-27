/** Left panel: the decision being tested, exactly as the simulated residents read it. */
import { useState, type ReactNode } from 'react';
import type { Scenario } from '../../types';
import { districtName, useApp } from '../context';
import { metres, niceDate, pct, pct2 } from '../format';
import { CHANNEL_SHORT, KIND_BADGE } from '../labels';
import { Icon } from '../icons';
import { ImputedChip, LangToggle, SectionHead } from './common';

/** A long list of districts reads better as a count: "All 20 Paris arrondissements". */
function zoneSummary(kinds: (string | undefined)[]): string {
  const arr = kinds.filter((k) => k === 'arrondissement').length;
  if (arr === kinds.length) return arr === 20 ? 'All 20 Paris arrondissements' : `${arr} Paris arrondissements`;
  return `${kinds.length} districts`;
}

export function ProposalPanel({
  scenario,
  collapsed,
  onToggle,
  footer,
}: {
  scenario: Scenario;
  collapsed: boolean;
  onToggle: () => void;
  footer?: ReactNode;
}) {
  const { districtsByIdx, focusDistrict, map, data } = useApp();
  const [lang, setLang] = useState<'en' | 'fr'>('en');
  const [expanded, setExpanded] = useState(false);
  const text = lang === 'en' ? scenario.proposalEn : scenario.proposalFr;
  const isBacktest = scenario.kind === 'backtest';
  const kicker = [isBacktest ? 'Real vote' : KIND_BADGE[scenario.kind], scenario.date ? niceDate(scenario.date) : null].filter(Boolean).join(' · ');
  return (
    <section className="panel side-panel proposal" aria-labelledby="proposal-title">
      <div className="panel-head">
        <div className="head-text">
          <div className="kicker" data-kind={scenario.kind}>
            {kicker}
          </div>
          <h2 id="proposal-title">{scenario.title}</h2>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show the proposal' : 'Hide the proposal'}
        >
          <Icon name="left" size={14} style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
        </button>
      </div>
      {!collapsed ? (
        <div className="panel-body">
          <p className="lede">{scenario.summary}</p>

          <div className="section">
            <SectionHead aside={<LangToggle lang={lang} onChange={setLang} />}>{isBacktest ? 'The official question' : 'What residents read'}</SectionHead>
            <div className={`notice ${expanded ? '' : 'clamped'}`} lang={lang}>
              <span>{text}</span>
            </div>
            <div className="row-between notice-foot">
              {text.length > 220 ? (
                <button type="button" className="link-btn" onClick={() => setExpanded(!expanded)}>
                  {expanded ? 'Show less' : 'Read all'}
                </button>
              ) : (
                <span />
              )}
              {lang === 'en' ? <span className="note">Residents read the French original</span> : null}
            </div>
          </div>

          <dl className="facts-compact">
            {scenario.site ? (
              <div className="f-wide">
                <dt>Site</dt>
                <dd>
                  <button type="button" className="link-btn" onClick={() => map?.focus(scenario.site!.x + 0.5, scenario.site!.y + 0.5, 1.4, true)}>
                    {scenario.site.label}
                  </button>
                  <span className="muted"> · rings at {scenario.site.ringsTiles.map((r) => metres(r * data.map.tileMeters)).join(', ')}</span>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Channel</dt>
              <dd>{CHANNEL_SHORT[scenario.channel]}</dd>
            </div>
            <div>
              <dt>Turnout</dt>
              <dd>
                <span className="num">{isBacktest ? pct2(scenario.turnoutTarget) : pct(scenario.turnoutTarget, 1)}</span>{' '}
                <span className="muted">{isBacktest ? 'real' : 'assumed'}</span>
              </dd>
            </div>
            <div className="f-wide">
              <dt>Who can take part</dt>
              <dd>
                {scenario.voterScope === 'paris_eligible' ? (
                  <>
                    Paris residents who can vote <ImputedChip title="Nationality is not in the dataset: it is estimated from INSEE statistics" />
                  </>
                ) : (
                  'Every adult resident'
                )}
              </dd>
            </div>
            {scenario.zoneDistricts?.length ? (
              <div className="f-wide">
                <dt>Area</dt>
                {scenario.zoneDistricts.length > 6 ? (
                  <dd>{zoneSummary(scenario.zoneDistricts.map((d) => districtsByIdx.get(d)?.kind))}</dd>
                ) : (
                  <dd className="chips">
                    {scenario.zoneDistricts.map((d) => (
                      <button key={d} type="button" className="chip chip-btn" onClick={() => focusDistrict(d)}>
                        {districtName(districtsByIdx, d)}
                      </button>
                    ))}
                  </dd>
                )}
              </div>
            ) : null}
            <div className="f-wide">
              <dt>Reactions by</dt>
              <dd>{scenario.mock ? 'Demo rules (no AI yet)' : scenario.models.reaction}</dd>
            </div>
          </dl>
          {scenario.notes?.length ? (
            <div className="section notes">
              {scenario.notes.map((n) => (
                <p key={n} className="section-note">
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}
