import AdviceItem from './AdviceItem.jsx';

// A signal group in the broken tab. Header is always visible; the advice list
// expands/collapses. Cards with a violation default to expanded; improvement-
// only cards default to collapsed (SPEC § what is broken?).

const COUNT_LABEL = { span: 'instances', metric: 'data points', log: 'records' };

export default function EntityCard({ group, open, onToggle }) {
  const cardClass = group.hasViolation ? 'broken' : 'broken-imp';
  return (
    <div className={`ecard ${cardClass}`}>
      <div className="ehdr" onClick={onToggle}>
        <span className={`badge badge-${group.signalType}`}>{group.signalType}</span>
        <span className="ename">{group.name}</span>
        <span className="emeta">
          {group.instances} {COUNT_LABEL[group.signalType] || 'instances'}
        </span>
        <span className={`chev ${open ? 'open' : ''}`}>&#9658;</span>
      </div>
      {open && (
        <div className="alist">
          {group.findings.map((f, i) => (
            <AdviceItem key={`${f.id}:${f.attributeKey}:${i}`} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}
