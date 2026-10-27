/** Right panel: tabs with the analysis of the current scenario. */
import type { Scenario } from '../../types';
import { useApp, type TabId } from '../context';
import { Icon } from '../icons';
import { BacktestTab } from './tabs/BacktestTab';
import { ConsultTab } from './tabs/ConsultTab';
import { DistrictsTab } from './tabs/DistrictsTab';
import { OverviewTab } from './tabs/OverviewTab';
import { TalkTab } from './tabs/TalkTab';
import { ThemesTab } from './tabs/ThemesTab';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'eye' },
  { id: 'consult', label: 'Who to consult', icon: 'pin' },
  { id: 'themes', label: 'Themes', icon: 'chat' },
  { id: 'districts', label: 'Districts', icon: 'map' },
  { id: 'backtest', label: 'Backtest', icon: 'ballot' },
  { id: 'talk', label: 'Talk', icon: 'people' },
];

export function availableTabs(s: Scenario | null): TabId[] {
  return TABS.filter((t) => t.id !== 'backtest' || Boolean(s?.backtest)).map((t) => t.id);
}

export function InsightPanel({
  tab,
  onTab,
  collapsed,
  onToggle,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { scenario } = useApp();
  const tabs = TABS.filter((t) => availableTabs(scenario).includes(t.id));
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview';
  return (
    <section className={`panel side-panel insights ${collapsed ? 'collapsed' : ''}`} aria-label="What the simulation shows">
      <div className="row-between" style={{ padding: '4px 6px 0 10px' }}>
        <h2 style={{ fontSize: 18, color: 'var(--wood-9)' }}>What the town says</h2>
        <button type="button" className="btn btn-icon btn-small" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Show the analysis' : 'Hide the analysis'}>
          <Icon name={collapsed ? 'left' : 'right'} size={14} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
      {!collapsed ? (
        <>
          <div className="tabs" role="tablist" aria-label="Analysis">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-controls={`tabpanel-${t.id}`}
                aria-selected={current === t.id}
                tabIndex={current === t.id ? 0 : -1}
                className="tab"
                onClick={() => onTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  const i = tabs.findIndex((x) => x.id === current);
                  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                  onTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
              >
                <Icon name={t.icon} size={12} />
                {t.label}
              </button>
            ))}
          </div>
          {/* key: a new tab (or scenario) starts scrolled to the top */}
          <div key={`${current}:${scenario?.id ?? ''}`} className="tab-body" role="tabpanel" id={`tabpanel-${current}`} aria-labelledby={`tab-${current}`}>
            {!scenario ? (
              <div className="empty">
                <Icon name="pencil" size={36} />
                <p style={{ marginTop: 8 }}>Your results will appear here once you run your proposal.</p>
              </div>
            ) : current === 'overview' ? (
              <OverviewTab />
            ) : current === 'consult' ? (
              <ConsultTab />
            ) : current === 'themes' ? (
              <ThemesTab />
            ) : current === 'districts' ? (
              <DistrictsTab />
            ) : current === 'backtest' ? (
              <BacktestTab />
            ) : (
              <TalkTab />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
