# OTel SemConv Checker — Phase 3: Frontend — session states

References: `references/SPEC.md` · `references/prototype-2026-04-15.html`
All paths relative to project root.

---

## QA model

Every phase has a `qa/phase-XX-<name>/` folder. Running `node validate.js`
from that folder is fully autonomous:
1. Spins up the phase-specific Docker Compose stack
2. Waits for services to be ready
3. Runs the test app with the phase scenario
4. Triggers stop / report generation where applicable
5. Runs assertions
6. Tears down the stack
7. Exits `0` (all pass) or `1` (any fail)

### Test app

A single Node.js test app at `qa/test-app/`. Accepts a `--scenario` flag:

```sh
node index.js --scenario phase-01   # spans + logs + custom metric only
node index.js --scenario phase-04   # adds richer span violations
node index.js --scenario phase-05   # adds http.* namespace to trigger missing tab
```

Each scenario is a superset of the previous. Sends OTLP/HTTP to
`localhost:4318` by default. Configurable via `--endpoint`.

### Synthetic test signals

| Signal | Type | Finding expected |
|--------|------|-----------------|
| `my-service` span | span | `deprecated` (violation): `http.method`, `http.url`, `http.status_code` |
| `my-service` span | span | `type_mismatch`: `http.status_code` sent as string, should be int |
| log record | log | `deprecated` (violation): `code.function` |
| `http.server.request.duration` metric | metric | `required_attribute_not_present` (violation): `http.request.method` omitted from the data point |
| `custom.request.count` metric | metric | suppressed — `custom.*` namespace |
| `http.request` span (phase-05+) | span | marks the `http` namespace active for the missing tab |

See `PLAN-phase-01-infrastructure.md` for full scenario detail and the note on
why Weaver never emits `missing_attribute` for required-but-absent attributes.

---

## Phase 3: Frontend — session states

**Outcome:** The frontend renders correctly in all three states. Start/stop
button works. Live counters increment during listening. Report shell renders
when session completes (no report content yet — just the container).

### What to build

- `frontend/` React + Vite app
- `Header` with status badge
- `SessionBar` with OTLP endpoint info and single start/stop button
- `IdlePane` — instructions
- `ListeningPane` — live counters (spans / metrics / logs / elapsed)
- `ReportPane` shell — resource banner placeholder, empty stat cards, empty tabs
- `useSession` hook — polls `GET /api/session` every 2s while listening
- Docker Compose updated: adds `frontend` service

#### Backend change required — live `signal_counts`

Phase 2 stubbed `signal_counts` to `{0,0,0}` during the `listening` state (real
counts only appear in `report`, from `statistics.total_entities_by_type`).
Assertion 6 ("span counter increments within 5s of listening") needs real live
counts, so phase 3 also:

- **`collector-config.yaml`**: enable the collector's internal-telemetry
  Prometheus endpoint (`service.telemetry.metrics`, e.g. `0.0.0.0:8888`).
- **`backend/`**: a `counts.js` that scrapes `http://collector:8888/metrics` and
  reads `otelcol_receiver_accepted_spans` / `_metric_points` / `_log_records`
  (note the possible `_total` suffix), summed across label sets. `session.start()`
  snapshots a baseline; `GET /api/session` returns `current − baseline` while
  `listening`. Any scrape error → fall back to `{0,0,0}` (never 500).
- This touches phase-1/phase-2 shared files (`collector-config.yaml` is
  `include`d by their QA stacks) — re-run phase-1 and phase-2 `validate.js`
  after the change to confirm no regression. The telemetry endpoint is additive
  and should not need a host port publish (backend reaches `collector:8888`
  in-network).

### QA

Builds on phase 2 stack. Adds Playwright.

#### Folder structure

```
qa/phase-03-frontend-states/
├── docker-compose.test.yml
├── validate.js
├── playwright.config.js
└── tests/
    └── session-states.spec.js
```

#### Assertions — phase 3

| # | Assertion |
|---|-----------|
| 1 | Page loads, idle state visible — "ready to listen" text present |
| 2 | Status badge reads "idle" |
| 3 | Start button visible and green |
| 4 | Click start → button changes to "stop", status badge reads "listening" |
| 5 | Pulse animation visible on listening badge |
| 6 | Span counter increments within 5s of listening state |
| 7 | Elapsed timer increments |
| 8 | Click stop → status badge reads "report ready" |
| 9 | Start button visible and green again after report |
| 10 | Resource banner visible in report state |

---