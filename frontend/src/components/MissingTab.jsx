import MissingCard from './MissingCard.jsx';

// The "what is missing?" tab body: one MissingCard per never-emitted signal,
// after the active signal filter is applied.

export default function MissingTab({ cards, isOpen, onToggle }) {
  if (cards.length === 0) {
    return <div className="tab-content-empty">Nothing missing for this signal.</div>;
  }
  return (
    <div className="tab-content">
      {cards.map((c) => (
        <MissingCard
          key={`${c.signalType} ${c.name}`}
          card={c}
          open={isOpen(c)}
          onToggle={() => onToggle(c)}
        />
      ))}
    </div>
  );
}
