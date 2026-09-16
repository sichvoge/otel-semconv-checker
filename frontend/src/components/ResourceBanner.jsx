import { resourceAttributes } from '../lib/transform.js';

// Always shown at the top of the report. Displays resource attributes; not
// filterable (SPEC § Report layout).

export default function ResourceBanner({ report }) {
  const attrs = resourceAttributes(report);
  return (
    <div className="rb">
      <span className="rbl">resource</span>
      <div className="rba">
        {attrs.length > 0 ? (
          attrs.map(([k, v]) => (
            <div className="rbattr" key={k}>
              {k}
              <span>=</span>
              {String(v)}
            </div>
          ))
        ) : (
          <span className="rb-empty">no resource attributes</span>
        )}
      </div>
    </div>
  );
}
