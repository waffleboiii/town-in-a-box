/** Themes: the arguments residents gave, how common they are, and which ones a consultation would miss. */
import { useState } from 'react';
import { districtName, useApp } from '../../context';
import { pct, pts } from '../../format';
import { Icon } from '../../icons';
import { LangToggle, VoiceChip } from '../common';

const SIDE_COLOR = { support: 'var(--support)', oppose: 'var(--oppose)', mixed: 'var(--neutral)' } as const;
const SIDE_LABEL = { support: 'for', oppose: 'against', mixed: 'mixed' } as const;

export function ThemesTab() {
  const { scenario, resultsById, residentsById, districtsByIdx, selectResident } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [lang, setLang] = useState<'en' | 'fr'>('en');
  if (!scenario) return null;
  const themes = scenario.themes.slice().sort((a, b) => b.share - a.share);
  const max = Math.max(0.01, ...themes.map((t) => t.share));
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 8 }}>
        <VoiceChip />
        <LangToggle lang={lang} onChange={setLang} />
      </div>
      {themes.length === 0 ? <div className="empty">No themes in this run.</div> : null}
      {themes.map((t) => {
        const expanded = open === t.id;
        return (
          <div key={t.id}>
            <button type="button" className="theme-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.id)}>
              <span className="t-label">
                {lang === 'fr' && t.labelFr ? t.labelFr : t.label}
                <span className="chip" style={{ color: SIDE_COLOR[t.side] }}>
                  {SIDE_LABEL[t.side]}
                </span>
                {t.missingGap > 0.005 ? (
                  <span className="chip chip-miss" title={`More common among people unlikely to take part (${pts(t.missingGap)})`}>
                    <Icon name="ghost" size={12} /> voices you’d miss
                  </span>
                ) : null}
              </span>
              <span className="t-share num">{pct(t.share)}</span>
              <span className="hbar">
                <span style={{ width: `${(t.share / max) * 100}%`, background: SIDE_COLOR[t.side] }} />
              </span>
            </button>
            {expanded ? (
              <div style={{ padding: '2px 0 8px' }}>
                {t.missingGap > 0.005 ? (
                  <p className="section-note">
                    {pts(t.missingGap)} more common among people unlikely to take part than among likely participants.
                  </p>
                ) : null}
                {t.quoteIds.length === 0 ? <p className="section-note">No example quotes.</p> : null}
                {t.quoteIds.slice(0, 3).map((id) => {
                  const r = resultsById.get(id);
                  const p = residentsById.get(id);
                  if (!r || !p) return null;
                  return (
                    <blockquote key={id} className="quote" lang={lang}>
                      “{lang === 'en' ? r.reasonEn : r.reasonFr}”
                      <span className="who">
                        <button type="button" className="link-btn" onClick={() => selectResident(id)}>
                          {p.name}
                        </button>
                        , {p.age}, {districtName(districtsByIdx, p.districtIdx)} (simulated)
                      </span>
                    </blockquote>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="section-note">Share = residents whose reason falls under this theme. Click a theme for example simulated quotes.</p>
    </div>
  );
}
