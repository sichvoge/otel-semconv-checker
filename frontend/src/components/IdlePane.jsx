// Idle state body: tell the user to point their exporter at the endpoint and
// press start.

export default function IdlePane({ session }) {
  const http = (session && session.otlp_http) || 'localhost:4318';
  return (
    <div className="idle-pane">
      <div className="state-title">ready to listen</div>
      <div className="state-sub">
        Press <strong>start</strong> to launch Weaver and begin collecting telemetry.
        <br />
        Point your OTLP exporter at <code>{http}</code>.
      </div>
    </div>
  );
}
