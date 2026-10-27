/** Logo, the scenario cards, the permanent "simulated" badge and the "How it works" button. */
import type { ScenarioIndexEntry } from '../../types';
import { KIND_BADGE } from '../labels';
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
}: {
  entries: ScenarioIndexEntry[];
  activeId: string | null;
  onPick: (id: string) => void;
  onHowItWorks: () => void;
}) {
  return (
    <header className="topbar">
      <div className="panel brand">
        <Icon name="house" size={34} />
        <div>
          <h1>Town-in-a-Box</h1>
          <small>Rehearse a consultation on 2,000 simulated residents</small>
        </div>
      </div>

      <nav className="scenario-strip" aria-label="Decisions to test">
        {[...entries, CUSTOM_ENTRY].map((e) => (
          <button key={e.id} type="button" className="scenario-card" aria-pressed={e.id === activeId} onClick={() => onPick(e.id)} title={e.subtitle}>
            <span className="sc-icon">
              <Icon name={ICON_FOR[e.icon] ?? 'map'} size={24} />
            </span>
            <span className="sc-title">{e.title}</span>
            <span className="sc-meta">
              <span className="badge-kind" data-kind={e.kind}>
                {KIND_BADGE[e.kind]}
              </span>
            </span>
          </button>
        ))}
      </nav>

      <div className="top-right">
        <div className="sim-badge" role="note">
          <Icon name="ghost" size={18} />
          <span>
            <strong>SIMULATED</strong> <span className="long">— not evidence of public opinion</span>
          </span>
        </div>
        <button type="button" className="btn" onClick={onHowItWorks} aria-label="How it works">
          <Icon name="question" size={16} />
          <span className="btn-label">How it works</span>
        </button>
      </div>
    </header>
  );
}
