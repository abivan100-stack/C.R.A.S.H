import { useState } from 'react';

import { useDataset } from './app/useDataset.ts';
import { useTheme } from './app/theme.ts';
import { Icon } from './components/Icon.tsx';
import { ReportForm } from './components/ReportForm.tsx';
import { ReportList } from './components/ReportList.tsx';
import { Notifications } from './components/Notifications.tsx';
import { BotPanel } from './components/BotPanel.tsx';
import { AnalyticsPage } from './components/AnalyticsPage.tsx';
import { ComparePage } from './components/ComparePage.tsx';
import { SimulatePage } from './components/SimulatePage.tsx';
import { MapPage } from './components/MapPage.tsx';
import type { CitizenRecord } from './app/api.ts';

type Tab = 'map' | 'analytics' | 'compare' | 'report' | 'simulate' | 'bot';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'compare', label: 'Compare' },
  { id: 'report', label: 'Reports' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'bot', label: 'C.R.A.S.H Bot' },
];

export function App(): JSX.Element { // migrated shell
  const dataset = useDataset();
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>('report');
  const [notifyOpen, setNotifyOpen] = useState(false);

  const onSaved = (report: CitizenRecord): void => dataset.addCitizenReport(report);

  return (
    <>
      <header className="app-header">
        <button className="brand" type="button" title="CRASH home" onClick={() => setTab('map')}>
          <span className="brand-mark">C</span>
          <span className="brand-text">
            <span className="brand-name">CRASH</span>
            <span className="brand-tag">Find Chennai's deadliest junctions - and fix them first.</span>
          </span>
        </button>
        <nav className="nav" aria-label="Primary">
          <div className="nav-pills" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`pill${tab === t.id ? ' active' : ''}`}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Notifications
            open={notifyOpen}
            unread={dataset.unread}
            items={dataset.notifications}
            onToggle={() => setNotifyOpen((o) => !o)}
            onClear={dataset.clearNotifications}
          />
          <button className="icon-btn" type="button" aria-label="Toggle theme" onClick={toggle}>
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} />
          </button>
        </nav>
      </header>

      <main>
        {dataset.error ? (
          <div className="section" role="alert">
            <div className="slabel">Data unavailable</div>
            <div className="stitle">The incident dataset could not be loaded.</div>
            <div className="sdesc">{dataset.error}</div>
          </div>
        ) : null}

        {tab === 'report' ? (
          <section className="app-section active" role="tabpanel" aria-label="Reports">
            <div className="report-root">
              <ReportForm records={dataset.records} theme={theme} onSaved={onSaved} />
              <ReportList reports={dataset.citizen} />
            </div>
          </section>
        ) : null}

        {tab === 'map' ? <MapPage records={dataset.records} monthCount={dataset.monthCount} theme={theme} /> : null}
        {tab === 'analytics' ? <AnalyticsPage records={dataset.records} monthCount={dataset.monthCount} theme={theme} /> : null}
        {tab === 'compare' ? <ComparePage records={dataset.records} monthCount={dataset.monthCount} theme={theme} /> : null}
        {tab === 'simulate' ? <SimulatePage records={dataset.records} monthCount={dataset.monthCount} /> : null}
        {tab === 'bot' ? <BotPanel records={dataset.records} /> : null}
      </main>
    </>
  );
}
