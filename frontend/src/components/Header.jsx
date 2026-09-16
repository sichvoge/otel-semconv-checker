// App header with the session status badge.
//   idle      -> "idle"           (gray)
//   listening -> "● listening"    (amber, pulsing dot)
//   report    -> "report ready"   (green)
//   error     -> "error"          (red)

const BADGE = {
  idle: { cls: 'status-idle', label: 'idle', pulse: false },
  listening: { cls: 'status-listening', label: 'listening', pulse: true },
  report: { cls: 'status-complete', label: 'report ready', pulse: false },
  error: { cls: 'status-error', label: 'error', pulse: false },
};

export default function Header({ status }) {
  const badge = BADGE[status] || BADGE.idle;
  return (
    <div className="header">
      <div className="hl">
        <div className="logo" />
        <span className="app-title">OTel SemConv Checker</span>
      </div>
      <span id="status-badge" className={badge.cls}>
        {badge.pulse && <span className="pulse" />}
        {badge.label}
      </span>
    </div>
  );
}
