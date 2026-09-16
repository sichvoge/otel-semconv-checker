// One finding inside an expanded entity card: level dot, finding id, message,
// and how many instances (attributes / data points) in the group exhibit it.

export default function AdviceItem({ finding }) {
  return (
    <div className="aitem">
      <div className={`adot ${finding.level}`} />
      <div className="aid">{finding.id}</div>
      <div className="amsg">{finding.message}</div>
      <div className="acnt">{finding.count}×</div>
    </div>
  );
}
