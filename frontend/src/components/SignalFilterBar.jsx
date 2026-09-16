import { signalBreakdown } from '../lib/transform.js';

// Per-tab signal filter. Always shows all three signal types with their group
// counts; a zero-count pill is dimmed and non-interactive (SPEC § Signal filter).

const SIGNALS = ['span', 'metric', 'log'];

export default function SignalFilterBar({ groups, active, onChange }) {
  const counts = signalBreakdown(groups);
  return (
    <div className="filter-bar">
      <span className="filter-label">signal</span>
      <span
        className={`pill ${active === 'all' ? 'active' : ''}`}
        onClick={() => onChange('all')}
      >
        all
      </span>
      {SIGNALS.map((s) => {
        const count = counts[s] || 0;
        const zero = count === 0;
        const cls = ['pill', `sig-${s}`];
        if (!zero && active === s) cls.push('active');
        if (zero) cls.push('zero');
        return (
          <span
            key={s}
            className={cls.join(' ')}
            onClick={zero ? undefined : () => onChange(s)}
          >
            {s}s · {count}
          </span>
        );
      })}
    </div>
  );
}
