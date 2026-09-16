// A never-emitted registry signal in the "what is missing?" tab: signal badge,
// name, metric requirement level, stability badge, and (expanded) the expected
// attributes as requirement-level chips — required → red, recommended → amber
// (SPEC § Tabs).

const STAB_CLASS = { stable: 'stab-stable' };
const LEVEL_LABEL = { required: 'required', recommended: 'recommended', opt_in: 'opt-in' };

export default function MissingCard({ card, open, onToggle }) {
  const stabClass = STAB_CLASS[card.stability] || 'stab-dev';
  const level = card.requirementLevel || 'recommended';
  return (
    <div className="ecard missing">
      <div className="ehdr" onClick={onToggle}>
        <span className={`badge badge-${card.signalType}`}>{card.signalType}</span>
        <span className="ename">{card.name}</span>
        <span className={`mlevel mlevel-${level}`}>{LEVEL_LABEL[level] || level}</span>
        <span className={`stab ${stabClass}`}>{card.stability}</span>
        <span className="emeta">never emitted</span>
        <span className={`chev ${open ? 'open' : ''}`}>&#9658;</span>
      </div>
      {open && (
        <div className="missing-body">
          <div className="missing-label">expected attributes per semconv</div>
          <div className="attr-chips">
            {card.attributes.map((a) => (
              <span className={`attr-chip ${a.requirement_level}`} key={a.name}>
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
