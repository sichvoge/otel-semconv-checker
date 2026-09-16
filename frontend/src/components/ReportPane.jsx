import { useEffect, useMemo, useState } from 'react';

import { buildBrokenModel, buildMissingModel } from '../lib/transform.js';
import ResourceBanner from './ResourceBanner.jsx';
import StatsGrid from './StatsGrid.jsx';
import TabBar from './TabBar.jsx';
import SignalFilterBar from './SignalFilterBar.jsx';
import BrokenTab from './BrokenTab.jsx';
import MissingTab from './MissingTab.jsx';

// Report state body. Phases 4-5 build both tabs: "what is broken?" (emitted
// signals with findings) and "what is missing?" (registry signals never
// emitted for the observed traffic).

export default function ReportPane({ report }) {
  const broken = useMemo(() => buildBrokenModel(report), [report]);
  const missing = useMemo(() => buildMissingModel(report), [report]);

  const [activeTab, setActiveTab] = useState('broken');
  const [sigFilter, setSigFilter] = useState({ broken: 'all', missing: 'all' });
  // name -> explicit open/closed override; absent means "use the default".
  const [openOverrides, setOpenOverrides] = useState({});

  useEffect(() => {
    setActiveTab('broken');
    setSigFilter({ broken: 'all', missing: 'all' });
    setOpenOverrides({});
  }, [report]);

  const groups = activeTab === 'broken' ? broken : missing;
  const filter = sigFilter[activeTab];
  const shown = filter === 'all' ? groups : groups.filter((g) => g.signalType === filter);

  // Broken cards default open when they carry a violation; missing cards default
  // open so the attribute chips are visible without a click.
  const defaultOpen = (item) => (activeTab === 'broken' ? Boolean(item.hasViolation) : true);
  const isOpen = (item) => (item.name in openOverrides ? openOverrides[item.name] : defaultOpen(item));
  const toggle = (item) => setOpenOverrides((prev) => ({ ...prev, [item.name]: !isOpen(item) }));
  const setFilter = (s) => setSigFilter((prev) => ({ ...prev, [activeTab]: s }));

  return (
    <div className="pane-report">
      <ResourceBanner report={report} />
      <StatsGrid
        broken={broken}
        missing={missing}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
      />
      <TabBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        brokenCount={broken.length}
        missingCount={missing.length}
      />
      <SignalFilterBar groups={groups} active={filter} onChange={setFilter} />
      {activeTab === 'broken' ? (
        <BrokenTab groups={shown} isOpen={isOpen} onToggle={toggle} />
      ) : (
        <MissingTab cards={shown} isOpen={isOpen} onToggle={toggle} />
      )}
    </div>
  );
}
