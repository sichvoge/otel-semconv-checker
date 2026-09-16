import { signalBreakdown } from '../lib/transform.js';

// Stat cards: broken count (clickable → broken tab), missing count (built in a
// later phase). SPEC § Report layout.

function breakdownText(groups) {
  const c = signalBreakdown(groups);
  const parts = [];
  if (c.span) parts.push(`${c.span} span`);
  if (c.metric) parts.push(`${c.metric} metric`);
  if (c.log) parts.push(`${c.log} log`);
  return parts.length ? parts.join(' · ') : '—';
}

export default function StatsGrid({ broken, missing, activeTab, onSelectTab }) {
  return (
    <div className="stats">
      <div
        className={`stat clickable ${activeTab === 'broken' ? 'active-stat' : ''}`}
        onClick={() => onSelectTab('broken')}
      >
        <div className="slabel">broken</div>
        <div className="sval r">{broken.length}</div>
        <div className="ssub">{breakdownText(broken)}</div>
      </div>
      <div
        className={`stat clickable ${activeTab === 'missing' ? 'active-stat' : ''}`}
        onClick={() => onSelectTab('missing')}
      >
        <div className="slabel">missing</div>
        <div className="sval a">{missing.length}</div>
        <div className="ssub">{breakdownText(missing)}</div>
      </div>
    </div>
  );
}
