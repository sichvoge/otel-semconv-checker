// OTLP endpoint info and the single start/stop button.
//   listening -> red "stop"
//   otherwise -> green "start" (starts a new session, clearing any report)

export default function SessionBar({ session, busy, onStart, onStop }) {
  const status = session ? session.status : 'idle';
  const listening = status === 'listening';
  const grpc = (session && session.otlp_grpc) || 'localhost:4317';
  const http = (session && session.otlp_http) || 'localhost:4318';

  return (
    <div className="sbar">
      <div className="sinfo">
        <span>OTLP/HTTP</span>
        <code>{http}</code>
      </div>
      <div className="sinfo">
        <span>OTLP/gRPC</span>
        <code>{grpc}</code>
      </div>
      <div className="sp" />
      {listening ? (
        <button id="main-btn" className="btn-stop" disabled={busy} onClick={onStop}>
          stop
        </button>
      ) : (
        <button id="main-btn" className="btn-start" disabled={busy} onClick={onStart}>
          start
        </button>
      )}
    </div>
  );
}
