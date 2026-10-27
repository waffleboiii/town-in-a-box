/** One bar across the top: logo, the scenario switcher, the "simulated" status and the "How it works" button. */
import type { ScenarioIndexEntry } from '../../types';
import { kindKicker, shortTitle } from '../labels';
import { Icon } from '../icons';

export const CUSTOM_ENTRY: ScenarioIndexEntry = {
  id: 'custom',
  title: 'Test your own idea',
  subtitle: 'Type a proposal, pick where, run it live',
  kind: 'custom',
  icon: 'pencil',
  mock: false,
};

const ICON_FOR: Record<string, string> = { scooter: 'scooter', car: 'car', datacenter: 'datacenter', pencil: 'pencil' };

export function TopBar({
  entries,
  activeId,
  onPick,
  onHowItWorks,
  demo,
}: {
  entries: ScenarioIndexEntry[];
  activeId: string | null;
  onPick: (id: string) => void;
  onHowItWorks: () => void;
  /** The current results are placeholders (no Nemotron run yet). */
  demo: boolean;
}) {
  return (
    <header className="topbar panel">
      <div className="brand">
        <Icon name="house" size={30} />
        <h1>Town-in-a-Box</h1>
      </div>

      <nav className="scenario-strip" aria-label="Decisions to test">
        {[...entries, CUSTOM_ENTRY].map((e) => (
          <button
            key={e.id}
            type="button"
            className="scenario-card"
            aria-pressed={e.id === activeId}
            onClick={() => onPick(e.id)}
            title={`${e.title}: ${e.subtitle}`}
          >
            <span className="sc-icon">
              <Icon name={ICON_FOR[e.icon] ?? 'map'} size={22} />
            </span>
            <span className="sc-text">
              <span className="sc-kicker">{kindKicker(e.kind, e.date)}</span>
              <span className="sc-title">{shortTitle(e.id, e.title)}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="top-right">
        <div className="sim-status" role="note">
          <span className="sim-line">
            <Icon name="ghost" size={16} />
            <span>
              <b>Simulated</b>
              <span className="long"> residents, not real opinion</span>
            </span>
          </span>
          {demo ? (
            <span className="demo-pill" title="These results are placeholders made without the AI. Real Nemotron results are pending.">
              Demo data
            </span>
          ) : null}
        </div>
        <button type="button" className="btn btn-small" onClick={onHowItWorks} aria-label="How it works">
          <Icon name="question" size={14} />
          <span className="btn-label">How it works</span>
        </button>
      </div>
    </header>
  );
}
