'use strict';

// Live signal counts during the `listening` state.
//
// The Weaver report only carries counts once the session closes
// (`statistics.total_entities_by_type`). For the live counters the frontend
// shows while listening, we scrape the OTel Collector's own internal-telemetry
// Prometheus endpoint (`service.telemetry.metrics`, published in-network on
// :8888) and read the receiver-accepted counters:
//
//   otelcol_receiver_accepted_spans          -> spans
//   otelcol_receiver_accepted_metric_points  -> metrics
//   otelcol_receiver_accepted_log_records    -> logs
//
// Prometheus client libraries may or may not append `_total` to a counter in
// the exposition, so both spellings are accepted. Values are summed across all
// label sets (there can be one series per receiver/transport).
//
// The collector is restarted at the start of every session (see collector.js),
// which zeroes these counters — but `SessionManager` still snapshots a baseline
// on start and reports `current - baseline`, so a stray pre-session count never
// leaks into the live view.

const METRICS_URL = process.env.COLLECTOR_METRICS_URL || 'http://collector:8888/metrics';
const SCRAPE_TIMEOUT_MS = Number(process.env.COLLECTOR_METRICS_TIMEOUT_MS || 2000);

const SERIES = {
  spans: ['otelcol_receiver_accepted_spans', 'otelcol_receiver_accepted_spans_total'],
  metrics: ['otelcol_receiver_accepted_metric_points', 'otelcol_receiver_accepted_metric_points_total'],
  logs: ['otelcol_receiver_accepted_log_records', 'otelcol_receiver_accepted_log_records_total'],
};

// Sum every sample line for the given metric names in a Prometheus exposition.
// A sample line looks like:  name{label="v",...} 123   (comment/HELP/TYPE skipped)
function sumMetric(text, names) {
  let total = 0;
  const wanted = new Set(names);
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const brace = line.indexOf('{');
    const space = line.indexOf(' ', brace === -1 ? 0 : brace);
    if (space === -1) continue;
    const name = (brace === -1 ? line.slice(0, space) : line.slice(0, brace)).trim();
    if (!wanted.has(name)) continue;
    const value = Number(line.slice(space + 1).trim().split(/\s+/)[0]);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

// Scrape the collector once. Throws on any transport / HTTP error — callers
// treat a throw as "counts unavailable" and fall back to zeros.
async function scrape() {
  const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`collector metrics endpoint returned ${res.status}`);
  const text = await res.text();
  return {
    spans: sumMetric(text, SERIES.spans),
    metrics: sumMetric(text, SERIES.metrics),
    logs: sumMetric(text, SERIES.logs),
  };
}

module.exports = { scrape, METRICS_URL };
