/**
 * Bottom-centre dock: the headline gap (the most important number on screen) and the big
 * view toggle: Everyone · Can vote · Likely to show up, plus the "after neighbours talked" switch.
 */
import { useMemo, type ReactNode } from 'react';
import type { Scenario, ViewMode } from '../../types';
import { rowsForView } from '../aggregate';
import { useApp } from '../context';
import { int, pct, pct2, pts } from '../format';
import { Icon } from '../icons';
import { viewLabel } from '../labels';
import { Num } from './common';

const VIEW_ICON: Record<ViewMode, string> = { everyone: 'people', eligible: 'ballot', attendees: 'walk' };

/** Hover text for a view button: who is in the group, and why its count is weighted.
 *  `drawn`: simulated residents in the view; `byChance`: live runs count each one by their chance of taking part. */
function viewTitle(v: ViewMode, scenario: Scenario, drawn: number, weighted: number, byChance: boolean): string {
  const counts = drawn === weighted ? '' : ` ${int(drawn)} simulated residents, weighted to the real population: they count as ${int(weighted)}.`;
  if (v === 'everyone') return `Every simulated adult, in Paris and the inner suburbs.${counts}`;
  if (v === 'eligible') {
    return scenario.voterScope === 'paris_eligible'
      ? `Lives in Paris (not the suburbs), is a French or EU citizen and is on the electoral roll.${counts}`
      : 'Every adult resident can take part in this channel.';
  }
  const turnout = `the expected turnout (${pct(scenario.turnoutTarget, 1)} of those who can take part)`;
  if (byChance) {
    return `Everyone who can take part, each counted by their chance of taking part, so together they match ${turnout}: ${int(drawn)} simulated residents count as about ${int(weighted)}.`;
  }
  return `The residents most likely to take part, up to ${turnout}.${counts}`;
}

export function ViewDock({ mobile }: { mobile?: ReactNode }) {
  const { scenario, views, view, setView, afterTalk, setAfterTalk, isLiveSample, aggCtx } = useApp();
  // Simulated residents in each view, for the hover text (they only change with the scenario).
  const drawn = useMemo(() => {
    const count = (v: ViewMode) => (scenario ? rowsForView(v, scenario.results, aggCtx).filter((r) => r.weight > 0).length : 0);
    return { everyone: count('everyone'), eligible: count('eligible'), attendees: count('attendees') };
  }, [scenario, aggCtx]);

  if (!scenario || !views) {
    return (
      <div className="dock-inner">
        <div className="gapboard gapboard-empty">
          <span className="gb-title">Who gets heard?</span>
          <p className="gb-sentence">
            {mobile
              ? 'Tap Proposal to describe your idea and pick where it happens. You will see who a consultation would hear, and who it would miss.'
              : 'Describe your proposal and run it: you will see who a consultation would hear, and who it would miss.'}
          </p>
        </div>
        {mobile}
      </div>
    );
  }

  const gap = views.attendees.yesShare - views.everyone.yesShare;
  const hasTalk = Boolean(scenario.aggregates.viewsAfterTalk) && scenario.conversations.length > 0;
  const scope = scenario.voterScope;
  const sentence =
    Math.abs(gap) < 0.02
      ? 'Likely participants think much like the town as a whole.'
      : `A consultation would hear a town ${Math.abs(Math.round(gap * 100))} points ${gap < 0 ? 'less' : 'more'} in favour than it really is.`;

  return (
    <div className="dock-inner">
      <div className="gapboard" aria-live="polite">
        <div className="gb-top">
          <span className="gb-title">Who gets heard?</span>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={afterTalk}
            disabled={!hasTalk}
            onClick={() => setAfterTalk(!afterTalk)}
            title={hasTalk ? `${scenario.conversations.length} neighbour conversations` : 'No neighbour conversations in this run'}
          >
            <span className="knob" aria-hidden="true" />
            <span>After neighbours talked</span>
          </button>
        </div>
        <div className="gb-grid">
          <div className="gb-cell">
            <div className="gb-label">
              <span className="lbl-long">If only likely participants are heard</span>
              <span className="lbl-short">Likely participants</span>
            </div>
            <div className="gb-value">
              <Num value={views.attendees.yesShare} format={(n) => pct(n)} />
              <small>support</small>
            </div>
          </div>
          <div className="gb-cell">
            <div className="gb-label">
              {scope === 'paris_eligible' ? (
                <>
                  <span className="lbl-long">Everyone, Paris and suburbs</span>
                  <span className="lbl-short">Everyone</span>
                </>
              ) : (
                'Everyone'
              )}
            </div>
            <div className="gb-value">
              <Num value={views.everyone.yesShare} format={(n) => pct(n)} />
              <small>support</small>
            </div>
          </div>
          <div className="gb-cell gb-gap">
            <div className="gb-label">Gap</div>
            <div className="gb-value">
              <Num value={gap} format={(n) => pts(n)} />
            </div>
          </div>
        </div>
        <p className="gb-sentence">
          {sentence}
          {scenario.backtest ? (
            <span className="gb-dim"> Real vote: {pct2(scenario.backtest.actual.yesShare)} “pour”.</span>
          ) : null}
          {isLiveSample ? <span className="gb-dim"> Small live sample: wide ranges.</span> : null}
        </p>
        <div className="view-toggle" role="group" aria-label="Whose voices to count">
          <div className="vt-group">
            {(['everyone', 'eligible', 'attendees'] as ViewMode[]).map((v) => (
              <button key={v} type="button" className="vt-btn" aria-pressed={view === v} onClick={() => setView(v)} title={viewTitle(v, scenario, drawn[v], views[v].n, Boolean(aggCtx.attendProb))}>
                <Icon name={VIEW_ICON[v]} size={20} />
                <span className="vt-text">
                  <span>{viewLabel(v, scope)}</span>
                  <span className="vt-count">
                    {isLiveSample && v === 'attendees' ? '≈' : ''}
                    <Num value={views[v].n} format={(n) => int(n)} ms={400} />
                    {v === 'everyone' ? (isLiveSample ? ' sampled' : ' residents') : isLiveSample && v === 'attendees' ? ' expected' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {mobile}
    </div>
  );
}
