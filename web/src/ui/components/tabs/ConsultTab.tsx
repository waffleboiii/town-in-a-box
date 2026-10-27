/** Who to consult: groups touched by the proposal but under-heard among likely participants. */
import { districtName, useApp } from '../../context';
import { pct } from '../../format';
import { Icon } from '../../icons';
import { ComputedChip, Pips } from '../common';

export function ConsultTab() {
  const { scenario, districtsByIdx, focusDistrict, highlightGroup, setHighlightGroup, groupsById } = useApp();
  if (!scenario) return null;
  const recs = scenario.consult;
  return (
    <div>
      <p className="tab-intro">
        Groups that carry more of the impact than they would have voices in the room. Use it as an outreach plan for the real consultation.
      </p>
      {recs.length === 0 ? (
        <div className="empty">No group is both strongly touched and under-heard in this run.</div>
      ) : (
        recs.map((r) => {
          const on = highlightGroup === r.groupId;
          const def = groupsById.get(r.groupId);
          const hasShares = r.impactShare !== undefined && r.voiceShare !== undefined;
          const scale = hasShares ? Math.max(r.impactShare!, r.voiceShare!, 0.01) : 1;
          return (
            <article key={r.groupId} className="consult-card" data-on={on}>
              <div className="cc-head">
                <h4>{r.label}</h4>
                <span className="cc-touched" title={`Mean computed exposure ${r.meanExposure.toFixed(1)} of 3`}>
                  <Pips value={r.meanExposure} label={`Exposure ${r.meanExposure.toFixed(1)} of 3`} />
                  <span className="num">{r.meanExposure.toFixed(1)}</span>
                </span>
              </div>
              {def?.description ? <p className="cc-who">{def.description}</p> : null}

              {hasShares ? (
                <div className="stake" title="Stake vs voice: their share of all the computed impact, and their share of the likely participants">
                  <span className="st-label">Impact</span>
                  <span className="st-track">
                    <span className="st-impact" style={{ width: `${(r.impactShare! / scale) * 100}%` }} />
                  </span>
                  <span className="st-val num">{pct(r.impactShare)}</span>
                  <span className="st-label">Voices</span>
                  <span className="st-track">
                    <span className="st-voice" style={{ width: `${(r.voiceShare! / scale) * 100}%` }} />
                  </span>
                  <span className="st-val num">{pct(r.voiceShare)}</span>
                </div>
              ) : (
                <div className="ratio" title="Their share among likely participants divided by their share of the population">
                  {r.representationRatio.toFixed(1)}× <small>{r.representationRatio < 1 ? 'under-heard' : 'heard'}</small>
                </div>
              )}

              <p className="why">{r.why}</p>

              {r.districts.length ? (
                <div className="chips">
                  {r.districts.map((d) => (
                    <button key={d} type="button" className="chip chip-btn" onClick={() => focusDistrict(d)}>
                      <Icon name="pin" size={12} /> {districtName(districtsByIdx, d)}
                    </button>
                  ))}
                </div>
              ) : null}

              <details className="outreach">
                <summary>How to reach them{r.hypotheses.length ? ' and what to ask' : ''}</summary>
                <ul className="mini-list">
                  {r.channels.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {r.hypotheses.length ? (
                  <>
                    <div className="kv-label">Hypotheses to test with them</div>
                    <ul className="mini-list">
                      {r.hypotheses.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </details>

              <button type="button" className={`btn btn-small ${on ? 'btn-primary' : ''}`} aria-pressed={on} onClick={() => setHighlightGroup(on ? null : r.groupId)}>
                <Icon name="eye" size={14} />
                {on ? 'Showing on the map' : 'Show them on the map'}
              </button>
            </article>
          );
        })
      )}
      <p className="section-note">
        <ComputedChip /> Impact: their share of all computed exposure. Voices: their share of the likely participants. Groups overlap, so shares do not add up
        to 100%.
      </p>
    </div>
  );
}
