/** Talk: one round of short neighbour conversations. Which arguments spread, and did anyone move? */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation } from '../../../types';
import { districtName, useApp } from '../../context';
import { pct } from '../../format';
import { Icon, StanceFace } from '../../icons';
import { stanceLabel } from '../../labels';
import { LangToggle, Seg, VoiceChip } from '../common';

const LINE_MS = 2600;

export function TalkTab() {
  const { scenario, residentsById, districtsByIdx, map, setAfterTalk, afterTalk } = useApp();
  const [lang, setLang] = useState<'en' | 'fr'>('en');
  const [filter, setFilter] = useState<'all' | 'moved'>('all');
  const [playing, setPlaying] = useState<{ id: string; line: number } | null>(null);
  const [shown, setShown] = useState(25);
  const [lastPlayed, setLastPlayed] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearInterval(timer.current), []);

  const stats = useMemo(() => {
    const convs = scenario?.conversations ?? [];
    let people = 0;
    let moved = 0;
    const spread = new Map<string, number>();
    for (const c of convs) {
      people += 2;
      const ma = c.stanceAfter.a !== c.stanceBefore.a;
      const mb = c.stanceAfter.b !== c.stanceBefore.b;
      moved += Number(ma) + Number(mb);
      if ((ma || mb) && c.themeId) spread.set(c.themeId, (spread.get(c.themeId) ?? 0) + 1);
    }
    return { people, moved, spread: [...spread.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4) };
  }, [scenario]);

  if (!scenario) return null;
  const convs = scenario.conversations.filter((c) => filter === 'all' || c.stanceAfter.a !== c.stanceBefore.a || c.stanceAfter.b !== c.stanceBefore.b);
  const themeLabel = (id?: string) => scenario.themes.find((t) => t.id === id)?.label ?? '';
  const name = (id: number) => residentsById.get(id)?.name.split(' ')[0] ?? `#${id}`;

  const play = async (c: Conversation) => {
    if (!map || playing) return;
    window.clearInterval(timer.current);
    setPlaying({ id: c.id, line: 0 });
    let line = 0;
    timer.current = window.setInterval(() => {
      line++;
      setPlaying((p) => (p && p.id === c.id ? { ...p, line } : p));
    }, LINE_MS);
    try {
      await map.playConversation(c, { lang, lineMs: LINE_MS });
    } finally {
      window.clearInterval(timer.current);
      setPlaying((p) => (p && p.id === c.id ? { id: c.id, line: c.lines.length } : p));
      window.setTimeout(() => setPlaying((p) => (p && p.id === c.id ? null : p)), 50);
    }
  };

  const transcriptFor = playing?.id ?? lastPlayed;

  return (
    <div>
      {scenario.conversations.length === 0 ? (
        <div className="empty">No neighbour conversations in this run.</div>
      ) : (
        <>
          <div className="stat-row">
            <div>
              <b className="num">{scenario.conversations.length}</b>
              <span>conversations</span>
            </div>
            <div>
              <b className="num">{stats.moved}</b>
              <span>changed their mind</span>
            </div>
            <div>
              <b className="num">{pct(stats.people ? stats.moved / stats.people : 0)}</b>
              <span>of the {stats.people} who talked</span>
            </div>
          </div>
          {stats.spread.length ? (
            <div className="section">
              <h3>Arguments that moved people</h3>
              <ul className="reason-list">
                {stats.spread.map(([id, n]) => (
                  <li key={id}>
                    <span className="rl-label">{themeLabel(id) || id}</span>
                    <span className="num">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button type="button" className="btn btn-small" onClick={() => setAfterTalk(!afterTalk)}>
            {afterTalk ? 'Show numbers before talk' : 'Show numbers after talk'}
          </button>

          <div className="row-between wrap tab-tools tab-tools-gap">
            <Seg
              label="Which conversations"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'moved', label: 'Someone moved' },
              ]}
            />
            <LangToggle lang={lang} onChange={setLang} />
          </div>
          {convs.slice(0, shown).map((c) => {
            const a = residentsById.get(c.a);
            return (
              <div key={c.id}>
              <button
                type="button"
                className="conv-row"
                aria-pressed={transcriptFor === c.id}
                disabled={Boolean(playing) && playing?.id !== c.id}
                onClick={() => {
                  setLastPlayed(c.id);
                  void play(c);
                }}
              >
                <span>
                  <span className="c-names">
                    {name(c.a)} & {name(c.b)}
                  </span>{' '}
                  <span className="muted">{a ? districtName(districtsByIdx, a.districtIdx) : ''}</span>
                  {c.themeId ? <div className="small muted">{themeLabel(c.themeId)}</div> : null}
                </span>
                <span className="row conv-faces">
                  <MiniShift before={c.stanceBefore.a} after={c.stanceAfter.a} />
                  <MiniShift before={c.stanceBefore.b} after={c.stanceAfter.b} />
                  <Icon name="play" size={16} />
                </span>
              </button>
                {transcriptFor === c.id ? (
                  <div className="transcript" aria-live="polite">
                    <div className="row-between transcript-head">
                      <b>
                        {name(c.a)} & {name(c.b)}
                      </b>
                      <VoiceChip />
                    </div>
                    {c.lines.map((l, i) => {
                      const state = !playing ? 'done' : i < playing.line ? 'done' : i === playing.line ? 'now' : '';
                      return (
                        <div key={i} className={`line ${state}`} lang={lang}>
                          <b>{name(l.speaker)}:</b> {lang === 'en' ? l.en : l.fr}
                        </div>
                      );
                    })}
                    <div className="row small wrap transcript-foot">
                      <Shift label={name(c.a)} before={c.stanceBefore.a} after={c.stanceAfter.a} />
                      <Shift label={name(c.b)} before={c.stanceBefore.b} after={c.stanceAfter.b} />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {convs.length > shown ? (
            <button type="button" className="btn btn-small" onClick={() => setShown(shown + 25)}>
              Show more ({convs.length - shown} left)
            </button>
          ) : null}
          <p className="section-note">Click a conversation to watch it on the map. Conversations are written by the AI as simulated voices.</p>
        </>
      )}
    </div>
  );
}

function MiniShift({ before, after }: { before: number; after: number }) {
  const moved = before !== after;
  return (
    <span className="shift" title={`${stanceLabel(before)} → ${stanceLabel(after)}`}>
      <StanceFace stance={before} size={16} />
      {moved ? (
        <>
          <Icon name="right" size={10} />
          <StanceFace stance={after} size={16} />
        </>
      ) : null}
    </span>
  );
}

function Shift({ label, before, after }: { label: string; before: number; after: number }) {
  return (
    <span className="shift">
      {label}: <StanceFace stance={before} size={18} />
      {before !== after ? (
        <>
          <Icon name="right" size={10} /> <StanceFace stance={after} size={18} /> <span className="moved">moved</span>
        </>
      ) : (
        <span className="muted">kept their view</span>
      )}
    </span>
  );
}
