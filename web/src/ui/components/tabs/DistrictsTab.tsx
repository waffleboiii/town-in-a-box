/** Districts: where support and the participation gap are biggest. Click a row to fly there. */
import { useMemo, useState } from 'react';
import type { DistrictAgg } from '../../../types';
import { aggregateByDistrict } from '../../aggregate';
import { useApp } from '../../context';
import { int, pct, pts } from '../../format';
import { Pips, Seg } from '../common';

type SortKey = 'gap' | 'support' | 'exposure';

export function DistrictsTab() {
  const { scenario, afterTalk, residentsById, districtsByIdx, focusDistrict, overlay, setOverlay, aggCtx, isLiveSample } = useApp();
  const [sort, setSort] = useState<SortKey>('gap');
  const [picked, setPicked] = useState<number | null>(null);

  const rows = useMemo<DistrictAgg[]>(() => {
    if (!scenario) return [];
    // Recompute when using after-talk stances (the file stores the before-talk breakdown).
    if (afterTalk || isLiveSample) return aggregateByDistrict(scenario.results, residentsById, { ...aggCtx, afterTalk });
    return scenario.aggregates.byDistrict;
  }, [scenario, afterTalk, residentsById, aggCtx, isLiveSample]);

  const minN = isLiveSample ? 3 : 8;
  const sorted = rows
    .filter((r) => districtsByIdx.has(r.districtIdx))
    .slice()
    .sort((a, b) => {
      const enoughA = a.n >= minN && (sort !== 'gap' || a.attendees.n >= 3) ? 1 : 0;
      const enoughB = b.n >= minN && (sort !== 'gap' || b.attendees.n >= 3) ? 1 : 0;
      if (enoughA !== enoughB) return enoughB - enoughA;
      if (sort === 'gap') return a.attendees.yesShare - a.everyone.yesShare - (b.attendees.yesShare - b.everyone.yesShare);
      if (sort === 'support') return b.everyone.yesShare - a.everyone.yesShare;
      return b.meanExposure - a.meanExposure;
    });

  return (
    <div>
      <div className="control-grid">
        <span className="small muted">Sort by</span>
        <Seg
          label="Sort districts by"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'gap', label: 'Gap' },
            { value: 'support', label: 'In favour' },
            { value: 'exposure', label: 'Touched' },
          ]}
        />
        <span className="small muted">Map colour</span>
        <Seg
          label="Colour the map by"
          value={overlay === 'stance' || overlay === 'exposure' ? overlay : 'none'}
          onChange={(v) => setOverlay(v)}
          options={[
            { value: 'none', label: 'Off' },
            { value: 'stance', label: 'In favour' },
            { value: 'exposure', label: 'Touched' },
          ]}
        />
      </div>
      <div className="legend district-legend">
        <span>
          <i className="sw-everyone" />
          Everyone
        </span>
        <span>
          <i className="sw-attendees" />
          Likely to show up
        </span>
        <span className="muted">centre line = 50% in favour</span>
      </div>
      {sorted.map((r) => {
        const d = districtsByIdx.get(r.districtIdx)!;
        const gap = r.attendees.yesShare - r.everyone.yesShare;
        const few = r.n < minN || r.attendees.n < 3;
        return (
          <button
            key={r.districtIdx}
            type="button"
            className="district-row"
            aria-pressed={picked === r.districtIdx}
            onClick={() => {
              setPicked(r.districtIdx);
              focusDistrict(r.districtIdx);
            }}
            title={`${d.fullName}: everyone ${pct(r.everyone.yesShare)}, likely to show up ${few ? 'too few' : pct(r.attendees.yesShare)} in favour (${int(r.n)} residents)`}
          >
            <span className="d-name">
              {d.kind === 'arrondissement' ? `Paris ${d.name}` : d.name}
              {d.kind === 'commune' ? (
                <span className="d-dept"> {d.dept}</span>
              ) : null}
            </span>
            <span className="dot-track" aria-hidden="true">
              <i className="everyone" style={{ left: `${r.everyone.yesShare * 100}%` }} />
              {!few ? <i className="attendees" style={{ left: `${r.attendees.yesShare * 100}%` }} /> : null}
            </span>
            <span className="d-gap">
              {sort === 'exposure' ? (
                <Pips value={r.meanExposure} />
              ) : sort === 'support' ? (
                pct(r.everyone.yesShare)
              ) : few ? (
                <span className="muted small">few</span>
              ) : (
                pts(gap)
              )}
            </span>
          </button>
        );
      })}
      <p className="section-note">
        Gap = likely participants minus everyone, in points. “Few” = too few likely participants there to say. With {int(rows.reduce((s, r) => s + r.n, 0))}{' '}
        residents, district numbers are noisy.
      </p>
    </div>
  );
}
