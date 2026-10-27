/** Who to consult: groups touched by the proposal but under-heard among likely participants. */
import { districtName, useApp } from '../../context';
import { pct } from '../../format';
import { Icon } from '../../icons';
import { Pips } from '../common';

export function ConsultTab() {
  const { scenario, districtsByIdx, focusDistrict, highlightGroup, setHighlightGroup, groupsById } = useApp();
  if (!scenario) return null;
  const recs = scenario.consult;
  return (
    <div>
      <p className="small" style={{ marginBottom: 10 }}>
        Groups that carry more of the impact than they would have voices in the room, if you only listened to likely participants. Use it as an
        outreach plan for the real consultation.
      </p>
      {recs.length === 0 ? (
        <div className="empty">No group is both strongly touched and under-heard in this run.</div>
      ) : (
        recs.map((r) => {
          const on = highlightGroup === r.groupId;
          const def = groupsById.get(r.groupId);
          return (
            <article key={r.groupId} className="card consult-card">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <h4>{r.label}</h4>
                  <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                    <span className="muted">Touched</span>
                    <Pips value={r.meanExposure} label={`Exposure ${r.meanExposure.toFixed(1)} of 3`} />
                    <span className="num">{r.meanExposure.toFixed(1)} / 3</span>
                  </div>
                </div>
                {r.impactShare !== undefined && r.voiceShare !== undefined ? (
                  <div className="stake" title="Stake vs voice: their share of all the computed impact, and their share of the likely participants">
                    <div className="ratio">
                      {pct(r.impactShare)}
                      <small>of the impact</small>
                    </div>
                    <div className="ratio ratio-voice">
                      {pct(r.voiceShare)}
                      <small>of the voices</small>
                    </div>
                  </div>
                ) : (
                  <div className="ratio" title="Their share among likely participants divided by their share of the population">
                    {r.representationRatio.toFixed(1)}×<small>{r.representationRatio < 1 ? 'under-heard' : 'heard'}</small>
                  </div>
                )}
              </div>
              <p className="why">{r.why}</p>
              {def?.description ? <p className="section-note">Who: {def.description}</p> : null}

              {r.districts.length ? (
                <>
                  <div className="kv-label">Where they live</div>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {r.districts.map((d) => (
                      <button key={d} type="button" className="chip chip-btn" onClick={() => focusDistrict(d)}>
                        <Icon name="pin" size={12} /> {districtName(districtsByIdx, d)}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <div className="kv-label">How to reach them</div>
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
              <div style={{ marginTop: 10 }}>
                <button type="button" className={`btn btn-small ${on ? 'btn-primary' : ''}`} aria-pressed={on} onClick={() => setHighlightGroup(on ? null : r.groupId)}>
                  <Icon name="eye" size={14} />
                  {on ? 'Showing on the map' : 'Show them on the map'}
                </button>
              </div>
            </article>
          );
        })
      )}
      <p className="section-note">
        Impact = their share of all computed exposure (where people live and work, their imputed situation). Voices = their share of the likely
        participants. Groups overlap, so shares do not add up to 100%. Computed, not AI.
      </p>
    </div>
  );
}
