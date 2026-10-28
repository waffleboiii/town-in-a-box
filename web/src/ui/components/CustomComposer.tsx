/** "Your proposal": write it, pick where it happens on the map, choose the channel, run it live. */
import type { ApiHealth, Channel } from '../../types';
import { districtName, useApp } from '../context';
import { SITE_RING_OPTIONS } from '../exposure';
import { draftProblems, SAMPLE_SIZE, type CustomDraft, type RunProgress } from '../customRun';
import { int, pct } from '../format';
import { Icon } from '../icons';
import { CHANNEL_LABEL, CHANNEL_TURNOUT } from '../labels';
import { Seg } from './common';

const EXAMPLES = [
  'Turn Place de la République into a car-free square with trees and a weekly market. Buses would be rerouted around it.',
  'Build 800 social-housing flats on a disused rail yard, with a school and a small park. Works would last four years.',
  'Ban through-traffic in this area: only residents, deliveries, taxis and buses could drive in. Speed limit 20 km/h.',
];

export function CustomComposer({
  draft,
  setDraft,
  progress,
  onRun,
  onCancel,
  hasResult,
  health,
  apiOffline,
}: {
  draft: CustomDraft;
  setDraft: (d: CustomDraft) => void;
  progress: RunProgress;
  onRun: () => void;
  onCancel: () => void;
  hasResult: boolean;
  health: ApiHealth | null;
  apiOffline: boolean;
}) {
  const { districtsByIdx } = useApp();
  const running = progress.status === 'running';
  const problems = draftProblems(draft);
  const set = (patch: Partial<CustomDraft>) => setDraft({ ...draft, ...patch });

  return (
    <section className="panel side-panel composer" aria-labelledby="custom-title">
      <div className="panel-head">
        <div className="head-text">
          <div className="kicker" data-kind="custom">
            Your proposal · live test
          </div>
          <h2 id="custom-title">Test your own idea</h2>
          <p className="panel-sub">
            {int(SAMPLE_SIZE)} residents react live, most of them in or near your area. It takes 2 to 3 minutes.
          </p>
        </div>
      </div>
      <div className="panel-body">
        <div className="step-label">1. What is the proposal?</div>
        <label className="visually-hidden" htmlFor="custom-text">
          Proposal text
        </label>
        <textarea
          id="custom-text"
          className="textarea"
          value={draft.text}
          disabled={running}
          maxLength={1200}
          placeholder="Describe it as you would to residents, in English or French."
          onChange={(e) => set({ text: e.target.value })}
        />
        {!draft.text ? (
          <div className="chips examples">
            <span className="small muted">Or start from an example:</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip chip-btn" onClick={() => set({ text: ex })} title={ex}>
                {ex.split(' ').slice(0, 4).join(' ')}…
              </button>
            ))}
          </div>
        ) : null}

        <div className="step-label">2. Where does it happen?</div>
        <Seg
          label="Area type"
          value={draft.areaKind}
          onChange={(v) => set({ areaKind: v })}
          options={[
            { value: 'districts', label: 'Districts', disabled: running },
            { value: 'site', label: 'A site', disabled: running },
          ]}
        />
        {draft.areaKind === 'districts' ? (
          <div className="step-body">
            <p className="small hint">
              <Icon name="pin" size={14} /> Click districts on the map to add or remove them.
            </p>
            <div className="chips">
              {draft.districts.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="chip chip-btn"
                  disabled={running}
                  onClick={() => set({ districts: draft.districts.filter((x) => x !== d) })}
                  aria-label={`Remove ${districtName(districtsByIdx, d)}`}
                >
                  {districtName(districtsByIdx, d)} <Icon name="close" size={10} />
                </button>
              ))}
              {draft.districts.length === 0 ? <span className="small muted">No district picked yet.</span> : null}
            </div>
          </div>
        ) : (
          <div className="step-body">
            <p className="small hint">
              <Icon name="pin" size={14} /> {draft.site ? 'Site placed. Click the map again to move it.' : 'Click the map to place the site.'}
            </p>
            <div className="row wrap">
              <span className="small muted">Directly affected within</span>
              <Seg
                label="Directly affected radius"
                value={String(draft.ringOption)}
                onChange={(v) => set({ ringOption: Number(v) })}
                options={SITE_RING_OPTIONS.map((o, i) => ({ value: String(i), label: o.label, disabled: running }))}
              />
            </div>
          </div>
        )}

        <div className="step-label">3. How will people be consulted?</div>
        <label className="visually-hidden" htmlFor="custom-channel">
          Channel
        </label>
        <select
          id="custom-channel"
          className="select"
          value={draft.channel}
          disabled={running}
          onChange={(e) => {
            const channel = e.target.value as Channel;
            set({ channel, turnout: CHANNEL_TURNOUT[channel] });
          }}
        >
          {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
        <p className="section-note">
          Assumed turnout: {pct(draft.turnout, 1)} of those who can take part
          {draft.channel === 'votation' ? ' (Paris votations 2023–24: 5.7% to 7.5%)' : ''}.
          {draft.channel === 'votation' ? ' Only Paris residents who can vote count.' : ' Every adult can attend.'}
        </p>

        <p className="section-note api-note">
          {apiOffline || !health
            ? 'Live API not reachable here: answers come from simple in-browser demo rules (no AI).'
            : health.mock
              ? 'Live API in mock mode (no API key yet): answers are demo heuristics, not Nemotron.'
              : `Reactions by ${health.models.reaction} on Nebius Token Factory.`}{' '}
          What changes for each resident is computed in your browser, not by the AI.
        </p>
      </div>
      <div className="panel-foot">
        {running ? (
          <>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <div className="row-between small">
              <span>
                {int(progress.done)} of {int(progress.total)} residents answered
                {progress.failed ? `, ${progress.failed} without answer` : ''}
              </span>
              <button type="button" className="btn btn-small" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-block" disabled={problems.length > 0} onClick={onRun}>
              <Icon name="sparkle" size={16} />
              {hasResult ? `Run again with ${SAMPLE_SIZE} residents` : `Run with ${SAMPLE_SIZE} residents`}
            </button>
            {problems.length ? (
              <ul className="mini-list muted problems">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        {progress.status === 'error' ? (
          <p className="banner banner-error banner-block">
            {progress.message}
          </p>
        ) : null}
        {progress.status === 'done' && progress.message ? <p className="section-note">Some answers failed: {progress.message}</p> : null}
        {progress.status === 'done' ? <p className="section-note">Results are in the panels. Click a coloured resident to see their reaction.</p> : null}
      </div>
    </section>
  );
}
