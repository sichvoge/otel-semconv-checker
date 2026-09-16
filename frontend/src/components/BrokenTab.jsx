import EntityCard from './EntityCard.jsx';

// The "what is broken?" tab body: one EntityCard per signal group, after the
// active signal filter is applied.

export default function BrokenTab({ groups, isOpen, onToggle }) {
  if (groups.length === 0) {
    return <div className="tab-content-empty">Nothing broken for this signal.</div>;
  }
  return (
    <div className="tab-content">
      {groups.map((g) => (
        <EntityCard
          key={`${g.signalType} ${g.name}`}
          group={g}
          open={isOpen(g)}
          onToggle={() => onToggle(g)}
        />
      ))}
    </div>
  );
}
