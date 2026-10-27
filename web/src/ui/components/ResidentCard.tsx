/**
 * Resident card: what THIS simulated citizen sees of the change.
 * Facts (dataset or imputed), what changes for them (computed), their reaction (simulated voice),
 * whether they would show up (calibrated), what they heard from neighbours, and a question box.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RenderPortrait } from '../../mapApi';
import type { Resident } from '../../types';
import { districtName, useApp } from '../context';
import { pct } from '../format';
import { Icon, PixelPortrait, StanceFace } from '../icons';
import { COMMUTE_LABEL, EXPOSURE_LEVEL, HOUSEHOLD_LABEL, NATIONALITY_LABEL, stanceLabel, TENURE_LABEL } from '../labels';
import { ComputedChip, ImputedChip, LangToggle, Pips, VoiceChip } from './common';

export interface AskEntry {
  id: number;
  q: string;
  answerEn?: string;
  answerFr?: string;
  error?: string;
  pending?: boolean;
  mock?: boolean;
}

function Portrait({ resident, renderPortrait }: { resident: Resident; renderPortrait: RenderPortrait | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !renderPortrait) return;
    try {
      const canvas = renderPortrait(resident.look, 6);
      el.replaceChildren(canvas);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    return () => el.replaceChildren();
  }, [resident, renderPortrait]);
  if (!renderPortrait || failed) {
    return (
      <div className="rc-portrait">
        <PixelPortrait look={resident.look} size={72} />
      </div>
    );
  }
  return <div className="rc-portrait" ref={ref} aria-hidden="true" />;
}

export function ResidentCard({
  residentId,
  renderPortrait,
  onClose,
  onNavigate,
  asks,
  onAsk,
}: {
  residentId: number;
  renderPortrait: RenderPortrait | null;
  onClose: () => void;
  onNavigate: (id: number) => void;
  asks: AskEntry[];
  onAsk: (question: string) => void;
}) {
  const { scenario, residentsById, resultsById, districtsByIdx, groupsById, map, view } = useApp();
  const [lang, setLang] = useState<'en' | 'fr'>('en');
  const [question, setQuestion] = useState('');
  const [playing, setPlaying] = useState(false);
  const resident = residentsById.get(residentId);
  const result = resultsById.get(residentId);

  // Residents in the current view, for prev/next.
  const ring = useMemo(() => {
    if (!scenario) return [...residentsById.keys()];
    return scenario.results
      .filter((r) => view === 'everyone' || (view === 'eligible' ? r.eligible : r.attendee))
      .map((r) => r.id)
      .sort((a, b) => a - b);
  }, [scenario, view, residentsById]);

  // Lowest score among likely participants = the bar they need to pass.
  const cutoff = useMemo(() => {
    const scores = (scenario?.results ?? []).filter((r) => r.attendee).map((r) => r.participationScore);
    return scores.length ? Math.min(...scores) : null;
  }, [scenario]);

  const conversation = useMemo(() => scenario?.conversations.find((c) => c.a === residentId || c.b === residentId) ?? null, [scenario, residentId]);

  if (!resident) return null;

  const step = (dir: 1 | -1) => {
    if (!ring.length) return;
    let i = ring.indexOf(residentId);
    if (i < 0) i = ring.findIndex((id) => id > residentId) - (dir === 1 ? 1 : 0);
    const next = ring[(i + dir + ring.length) % ring.length];
    onNavigate(next);
  };

  const another = (groupId: string) => {
    const pool = (scenario?.results ?? [])
      .map((r) => r.id)
      .filter((id) => id !== residentId && residentsById.get(id)?.groupIds.includes(groupId));
    if (!pool.length) return;
    onNavigate(pool[Math.floor(Math.random() * pool.length)]);
  };

  const workName = resident.workDistrictIdx !== null ? districtName(districtsByIdx, resident.workDistrictIdx) : null;
  const imp = resident.imputed;
  const other = conversation ? residentsById.get(conversation.a === residentId ? conversation.b : conversation.a) : undefined;
  const meIsA = conversation?.a === residentId;

  return (
    <section className="panel side-panel resident-card" aria-labelledby="rc-name">
      <div className="rc-head">
        <Portrait resident={resident} renderPortrait={renderPortrait} />
        <div style={{ minWidth: 0 }}>
          <h2 id="rc-name" className="rc-name">
            {resident.name}
          </h2>
          <div className="rc-sub">
            {resident.age} · {resident.occupationEn || resident.occupation}
          </div>
          <div className="rc-sub row wrap" style={{ gap: 6 }}>
            <Icon name="house" size={14} /> {districtName(districtsByIdx, resident.districtIdx)}
            {resident.districtSource === 'imputed' ? <ImputedChip title="The dataset row had no arrondissement; it was assigned using occupation and education." /> : null}
          </div>
          <span className="chip" style={{ marginTop: 4 }}>
            simulated resident
          </span>
        </div>
        <button type="button" className="btn btn-icon btn-small" onClick={onClose} aria-label="Close resident card">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="panel-body">
        <div className="section">
          <dl className="facts facts-3">
            <dt>Household</dt>
            <dd>{HOUSEHOLD_LABEL[resident.household] ?? resident.householdRaw}</dd>
            <dd className="chipcell">
              <span className="chip">dataset</span>
            </dd>
            <dt>Housing</dt>
            <dd>{TENURE_LABEL[imp.tenure]}</dd>
            <dd className="chipcell">
              <ImputedChip />
            </dd>
            <dt>Car</dt>
            <dd>{imp.car ? (imp.heavyCar ? 'Yes, a heavy one (1.6 t+)' : 'Yes, a lighter one') : 'No car'}</dd>
            <dd className="chipcell">
              <ImputedChip />
            </dd>
            <dt>Commute</dt>
            <dd>
              {COMMUTE_LABEL[resident.commuteMode]}
              {workName ? ` to ${workName}` : ''}
            </dd>
            <dd className="chipcell">
              <ImputedChip />
            </dd>
            <dt>Can vote</dt>
            <dd>
              {resident.eligibleParis ? 'Yes, in Paris votations' : 'No, not in Paris votations'}
              <span className="muted"> ({NATIONALITY_LABEL[imp.nationality]})</span>
            </dd>
            <dd className="chipcell">
              <ImputedChip />
            </dd>
          </dl>
        </div>

        {!result ? (
          <div className="section">
            <div className="card callout">
              {scenario?.kind === 'custom'
                ? 'This resident was not in the live sample of your proposal. Pick a coloured resident, or use Next.'
                : 'No reaction for this resident in this scenario.'}
            </div>
          </div>
        ) : (
          <>
            <div className="section">
              <h3>
                <Icon name="pin" size={16} /> What changes for them
              </h3>
              <div className="row small wrap" style={{ gap: 8, marginBottom: 2 }}>
                <Pips value={result.exposure.score} label={`Exposure ${result.exposure.score} of 3`} />
                <b>Touched: {EXPOSURE_LEVEL[result.exposure.score].toLowerCase()}</b>
                <ComputedChip />
              </div>
              <p className="section-note" style={{ marginTop: 0 }}>
                Computed from where they live and their situation, not by the AI.
              </p>
              {result.exposure.reasons.map((r) => (
                <div key={r.code + r.text} className="reason">
                  <span className="r-icon">
                    <Icon name={r.icon} size={18} />
                  </span>
                  <span>
                    {r.text}
                    {r.at?.length ? (
                      <button type="button" className="link-btn r-at" onClick={() => map?.focus(r.at![0][0] + 0.5, r.at![0][1] + 0.5, 2.2, true)}>
                        Show on map
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>

            <div className="section">
              <div className="row-between">
                <h3>
                  <Icon name="chat" size={16} /> Their reaction
                </h3>
                <LangToggle lang={lang} onChange={setLang} />
              </div>
              <div className="card voice">
                <StanceFace stance={result.stance} size={36} />
                <div>
                  <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
                    <b style={{ fontFamily: 'var(--font-px)', fontSize: 17 }}>{stanceLabel(result.stance)}</b>
                    <VoiceChip />
                  </div>
                  <blockquote lang={lang}>“{lang === 'en' ? result.reasonEn : result.reasonFr}”</blockquote>
                  {result.behaviourEn ? (
                    <p className="small" style={{ marginTop: 6 }}>
                      <b>What they would do:</b> {result.behaviourEn}
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="section-note">
                They feel affected {result.affectedLLM}/3 (AI’s own estimate); computed: {result.exposure.score}/3.
                {result.runStances && result.runStances.length > 1 ? ` Across ${result.runStances.length} runs: ${result.runStances.map((s) => (s > 0 ? `+${s}` : `${s}`)).join(', ')}.` : ''}
              </p>
            </div>

            <div className="section">
              <h3>
                <Icon name="walk" size={16} /> Would they show up?
              </h3>
              <div className="meter" role="img" aria-label={`Participation score ${pct(result.participationScore)}`}>
                <span style={{ width: `${Math.min(100, result.participationScore * 100)}%` }} />
                {cutoff !== null ? <i className="meter-mark" style={{ left: `${Math.min(100, cutoff * 100)}%` }} title="Score needed to count as a likely participant" /> : null}
              </div>
              <p className="small">
                Likely to show up:{' '}
                <span className={`yesno ${result.attendee ? 'yes' : 'no'}`}>{result.attendee ? 'Yes' : 'No'}</span>
                {!result.eligible ? <span className="muted"> (cannot take part in this channel)</span> : null}
              </p>
              <p className="section-note">
                Score {pct(result.participationScore)} from turnout patterns for people like them and how much this touches them. Their own answer (
                {pct(result.wouldParticipateLLM)}) only nudges it. The black mark is the score needed to count.
              </p>
            </div>

            {conversation && other ? (
              <div className="section">
                <h3>
                  <Icon name="people" size={16} /> Heard from a neighbour
                </h3>
                <div className="card transcript">
                  {conversation.lines.slice(0, 3).map((l, i) => (
                    <div key={i} className="line done" lang={lang}>
                      <b>{residentsById.get(l.speaker)?.name.split(' ')[0]}:</b> {lang === 'en' ? l.en : l.fr}
                    </div>
                  ))}
                  <div className="row small" style={{ gap: 6, marginTop: 6 }}>
                    Their view: <StanceFace stance={meIsA ? conversation.stanceBefore.a : conversation.stanceBefore.b} size={18} />
                    <Icon name="right" size={10} />
                    <StanceFace stance={meIsA ? conversation.stanceAfter.a : conversation.stanceAfter.b} size={18} />
                    {stanceLabel(meIsA ? conversation.stanceAfter.a : conversation.stanceAfter.b)}
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={playing || !map}
                    onClick={async () => {
                      if (!map) return;
                      setPlaying(true);
                      try {
                        await map.playConversation(conversation, { lang });
                      } finally {
                        setPlaying(false);
                      }
                    }}
                  >
                    <Icon name="play" size={14} /> {playing ? 'Playing…' : 'Watch on the map'}
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => onNavigate(other.id)}>
                    Meet {other.name.split(' ')[0]}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="section">
              <h3>
                <Icon name="question" size={16} /> Ask them a question
              </h3>
              <form
                className="ask-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = question.trim();
                  if (!q) return;
                  onAsk(q);
                  setQuestion('');
                }}
              >
                <label className="visually-hidden" htmlFor="ask-input">
                  Your question
                </label>
                <input
                  id="ask-input"
                  className="input"
                  value={question}
                  maxLength={300}
                  placeholder="e.g. What would change your mind?"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" className="btn btn-primary btn-small" disabled={!question.trim() || asks.some((a) => a.pending)}>
                  Ask
                </button>
              </form>
              {asks
                .slice()
                .reverse()
                .map((a) => (
                  <div key={a.id} className="card answer" aria-live="polite">
                    <div className="q">You: {a.q}</div>
                    {a.pending ? (
                      <div className="muted">Thinking…</div>
                    ) : a.error ? (
                      <div className="no">{a.error}</div>
                    ) : (
                      <div lang={lang}>
                        {firstName(resident)}: “{lang === 'en' ? a.answerEn : a.answerFr}”
                        {a.mock ? <span className="chip" style={{ marginLeft: 6 }}>demo answer</span> : null}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </>
        )}
        {resident.groupIds.length ? (
          <div className="section row wrap" style={{ gap: 4 }}>
            <span className="small muted">Meet another:</span>
            {resident.groupIds.slice(0, 3).map((g) => (
              <button key={g} type="button" className="chip chip-btn" onClick={() => another(g)} title="Meet another resident from this group">
                {groupsById.get(g)?.label ?? g}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rc-foot">
        <button type="button" className="btn btn-small" onClick={() => step(-1)} aria-label="Previous resident">
          <Icon name="left" size={12} /> Prev
        </button>
        <button type="button" className="btn btn-small" onClick={() => step(1)} aria-label="Next resident">
          Next <Icon name="right" size={12} />
        </button>
        <span className="small muted" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
          in this view
        </span>
      </div>
    </section>
  );
}

function firstName(r: Resident) {
  return r.name.split(' ')[0];
}
