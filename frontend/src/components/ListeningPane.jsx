import { useEffect, useState } from 'react';

// Listening state body: live counters for spans / metrics / logs / elapsed.
// Counts come from GET /api/session (polled every 2s by useSession). Elapsed is
// derived locally from `started_at` and ticks every second so it advances
// smoothly between polls.

function elapsedSeconds(startedAt) {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

export default function ListeningPane({ session }) {
  const startedAt = session && session.started_at;
  const counts = (session && session.signal_counts) || { spans: 0, metrics: 0, logs: 0 };
  const [elapsed, setElapsed] = useState(() => elapsedSeconds(startedAt));

  useEffect(() => {
    setElapsed(elapsedSeconds(startedAt));
    const id = setInterval(() => setElapsed(elapsedSeconds(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <div className="listening-pane">
      <div className="state-title">
        <span className="pulse" />
        listening for telemetry
      </div>
      <div className="state-sub">
        Weaver is running and collecting OTLP traffic.
        <br />
        Send telemetry, then press <strong>stop</strong> to generate the report.
      </div>
      <div className="live-counters">
        <div className="counter">
          <div className="counter-value" id="cnt-spans">{counts.spans}</div>
          <div className="counter-label">spans</div>
        </div>
        <div className="counter">
          <div className="counter-value" id="cnt-metrics">{counts.metrics}</div>
          <div className="counter-label">metric datapoints</div>
        </div>
        <div className="counter">
          <div className="counter-value" id="cnt-logs">{counts.logs}</div>
          <div className="counter-label">logs</div>
        </div>
        <div className="counter">
          <div className="counter-value" id="cnt-elapsed">{elapsed}s</div>
          <div className="counter-label">elapsed</div>
        </div>
      </div>
    </div>
  );
}
