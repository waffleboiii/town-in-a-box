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
import { ComputedChip, ImputedChip, LangToggle, Pips, SectionHead, VoiceChip } from './common';

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
  // One card is reused for every resident: a half-typed question stays with the resident it was meant for.
  const [draft, setDraft] = useState({ residentId, text: '' });
  const question = draft.residentId === residentId ? draft.text : '';
  const setQuestion = (text: string) => setDraft({ residentId, text });
  const [playingId, setPlayingId] = useState<string | null>(null);
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

  // Another resident: start at the top (their reaction). A new question or answer: bring it into view.
  const bodyRef = useRef<HTMLDivElement>(null);
  const newestRef = useRef<HTMLDivElement>(null);
  const newest = asks[asks.length - 1];
  const newestKey = newest ? `${newest.id}:${newest.pending ? 'wait' : 'done'}` : '';
  const shown = useRef({ residentId, newestKey });
  useEffect(() => {
    const prev = shown.current;
    shown.current = { residentId, newestKey };
    const body = bodyRef.current;
    const el = newestRef.current;
    if (!body) return;
    if (prev.residentId !== residentId) {
      body.scrollTo({ top: 0 });
      return;
    }
    if (!newestKey || prev.newestKey === newestKey || !el) return;
    // Scroll the card only (never the page), just enough to show the entry. An answer that lands
    // while the reader has scrolled away from its question (to reread something) leaves them there.
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const answered = newestKey.endsWith(':done');
    if (answered && (r.top > b.bottom || r.bottom < b.top)) return;
    const by = r.top < b.top ? r.top - b.top - 8 : r.bottom > b.bottom ? Math.min(r.bottom - b.bottom + 8, r.top - b.top - 8) : 0;
    if (by) body.scrollBy({ top: by, behavior: 'smooth' });
  }, [residentId, newestKey]);

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
        <div className="rc-id">
          <div className="kicker">Simulated resident</div>
          <h2 id="rc-name" className="rc-name">
            {resident.name}
          </h2>
          <div className="rc-sub">
            {resident.age} · {resident.occupationEn || resident.occupation}
          </div>
          <div className="rc-sub rc-home">
            <Icon name="house" size={14} /> {districtName(districtsByIdx, resident.districtIdx)}
            {resident.districtSource === 'imputed' ? (
              <ImputedChip short title="The dataset row had no arrondissement; it was assigned using occupation and education." />
            ) : null}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close resident card">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="panel-body" ref={bodyRef}>
        {result ? (
          <>
            <div className="section">
              <SectionHead aside={<LangToggle lang={lang} onChange={setLang} />}>Their reaction</SectionHead>
              <div className="voice" data-side={result.stance > 0 ? 'support' : result.stance < 0 ? 'oppose' : 'neutral'}>
                <StanceFace stance={result.stance} size={36} />
                <div>
                  <div className="voice-head">
                    <b>{stanceLabel(result.stance)}</b>
                    <VoiceChip />
                  </div>
                  <blockquote lang={lang}>“{lang === 'en' ? result.reasonEn : result.reasonFr}”</blockquote>
                  {result.behaviourEn ? (
                    <p className="small voice-do">
                      <b>What they would do:</b> {result.behaviourEn}
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="section-note">
                They feel affected {result.affectedLLM}/3 (the AI’s own estimate); computed: {result.exposure.score}/3.
                {result.runStances && result.runStances.length > 1 ? ` Across ${result.runStances.length} runs: ${result.runStances.map((s) => (s > 0 ? `+${s}` : `${s}`)).join(', ')}.` : ''}
              </p>
            </div>

            <div className="section">
              <SectionHead aside={<ComputedChip />}>What changes for them</SectionHead>
              <div className="touched">
                <Pips value={result.exposure.score} label={`Exposure ${result.exposure.score} of 3`} />
                <b>Touched: {EXPOSURE_LEVEL[result.exposure.score].toLowerCase()}</b>
              </div>
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
          </>
        ) : (
          <div className="section">
            <div className="callout">
              {scenario?.kind === 'custom'
                ? 'This resident was not in the live sample of your proposal. Pick a coloured resident, or use Next.'
                : 'No reaction for this resident in this scenario.'}
            </div>
          </div>
        )}

        <div className="section">
          <SectionHead>About them</SectionHead>
          <dl className="facts">
            <dt>Household</dt>
            <dd>{HOUSEHOLD_LABEL[resident.household] ?? resident.householdRaw}</dd>
            <dt>Housing</dt>
            <dd>
              {TENURE_LABEL[imp.tenure]} <ImputedChip short />
            </dd>
            <dt>Car</dt>
            <dd>
              {imp.car ? (imp.heavyCar ? 'Yes, a heavy one (1.6 t+)' : 'Yes, a lighter one') : 'No car'} <ImputedChip short />
            </dd>
            <dt>Commute</dt>
            <dd>
              {COMMUTE_LABEL[resident.commuteMode]}
              {workName ? ` to ${workName}` : ''} <ImputedChip short />
            </dd>
            <dt>Can vote</dt>
            <dd>
              {resident.eligibleParis ? 'Yes, in Paris votations' : 'Not in Paris votations'}
              <span className="muted"> · {NATIONALITY_LABEL[imp.nationality]}</span> <ImputedChip short />
            </dd>
          </dl>
          <p className="section-note">
            <span className="tag tag-imputed">est.</span> estimated from INSEE statistics; the NVIDIA dataset does not include it.
          </p>
        </div>

        {result ? (
          <>
            <div className="section">
              <SectionHead
                aside={
                  <span className={`yesno ${result.attendee ? 'yes' : 'no'}`}>{result.attendee ? 'Likely to show up' : 'Unlikely to show up'}</span>
                }
              >
                Would they show up?
              </SectionHead>
              <div className="meter" role="img" aria-label={`Participation score ${pct(result.participationScore)}`}>
                <span style={{ width: `${Math.min(100, result.participationScore * 100)}%` }} />
                {cutoff !== null ? <i className="meter-mark" style={{ left: `${Math.min(100, cutoff * 100)}%` }} title="Score needed to count as a likely participant" /> : null}
              </div>
              <p className="section-note">
                {!result.eligible ? 'They cannot take part in this channel. ' : ''}
                Score {pct(result.participationScore)}, from turnout patterns for people like them and how much this touches them. Their own answer (
                {pct(result.wouldParticipateLLM)}) only nudges it. The dark mark is the score needed to count.
              </p>
            </div>

            {conversation && other ? (
              <div className="section">
                <SectionHead>Heard from a neighbour</SectionHead>
                <div className="transcript">
                  {conversation.lines.map((l, i) => (
                    <div key={i} className="line done" lang={lang}>
                      <b>{residentsById.get(l.speaker)?.name.split(' ')[0]}:</b> {lang === 'en' ? l.en : l.fr}
                    </div>
                  ))}
                  <div className="row small transcript-foot">
                    Their view: <StanceFace stance={meIsA ? conversation.stanceBefore.a : conversation.stanceBefore.b} size={18} />
                    <Icon name="right" size={10} />
                    <StanceFace stance={meIsA ? conversation.stanceAfter.a : conversation.stanceAfter.b} size={18} />
                    {stanceLabel(meIsA ? conversation.stanceAfter.a : conversation.stanceAfter.b)}
                  </div>
                </div>
                <div className="row btn-row">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={playingId === conversation.id || !map}
                    onClick={async () => {
                      if (!map) return;
                      setPlayingId(conversation.id);
                      try {
                        await map.playConversation(conversation, { lang });
                      } finally {
                        setPlayingId((p) => (p === conversation.id ? null : p));
                      }
                    }}
                  >
                    <Icon name="play" size={14} /> {playingId === conversation.id ? 'Playing…' : 'Watch on the map'}
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => onNavigate(other.id)}>
                    Meet {other.name.split(' ')[0]}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="section">
              <SectionHead>Ask them a question</SectionHead>
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
                .map((a, i) => (
                  <div key={a.id} ref={i === 0 ? newestRef : undefined} className="answer" aria-live="polite">
                    <div className="q">You: {a.q}</div>
                    {a.pending ? (
                      <div className="muted">Thinking…</div>
                    ) : a.error ? (
                      <div className="no">{a.error}</div>
                    ) : (
                      <div lang={lang}>
                        {firstName(resident)}: “{lang === 'en' ? a.answerEn : a.answerFr}”{' '}
                        {a.mock ? <span className="tag tag-demo">demo answer</span> : null}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </>
        ) : null}
        {resident.groupIds.length ? (
          <div className="section chips">
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
        <span className="small muted rc-foot-note">in this view</span>
      </div>
    </section>
  );
}

function firstName(r: Resident) {
  return r.name.split(' ')[0];
}
