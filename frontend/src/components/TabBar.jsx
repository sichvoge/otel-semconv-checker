// Two tabs: "what is broken?" and "what is missing?". The missing tab is a
// placeholder until a later phase.

export default function TabBar({ activeTab, onSelectTab, brokenCount, missingCount }) {
  return (
    <div className="tab-bar">
      <div
        className={`tab ${activeTab === 'broken' ? 'active' : ''}`}
        onClick={() => onSelectTab('broken')}
      >
        what is broken?
        <span className="tab-count tc-broken">{brokenCount}</span>
      </div>
      <div
        className={`tab ${activeTab === 'missing' ? 'active' : ''}`}
        onClick={() => onSelectTab('missing')}
      >
        what is missing?
        <span className="tab-count tc-missing">{missingCount}</span>
      </div>
    </div>
  );
}
