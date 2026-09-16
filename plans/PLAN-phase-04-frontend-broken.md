# OTel SemConv Checker — Phase 4: Frontend — broken tab

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

## Phase 4: Frontend — broken tab

**Outcome:** The "what is broken?" tab renders correctly. Signal groups are
grouped correctly. Custom namespace transform is applied. Deprecated findings
appear. Missing required attributes appear.

### What to build

- `BrokenTab` component
- `EntityCard` with expand/collapse
- `AdviceItem` with finding id, message, count
- `SignalFilterBar` with per-tab signal pills (zero-count non-interactive)
- `StatsGrid` — broken count with breakdown, clickable
- Custom namespace transform using `GET /api/config` → `custom_namespaces`
- Entity grouping by `signal_type + signal_name`
- Finding deduplication with instance counts

### QA

Builds on phase 3 stack. Uses Playwright. Uses phase-04 scenario.

#### Assertions — phase 4

| # | Assertion |
|---|-----------|
| 1 | Broken tab visible and active by default |
| 2 | Broken stat card shows correct count |
| 3 | Signal filter pills show spans/metrics/logs with counts |
| 4 | `my-service` span card visible in broken tab |
| 5 | `deprecated` finding for `http.method` visible when card expanded |
| 6 | `deprecated` finding for `http.url` visible when card expanded |
| 7 | `required_attribute_not_present` finding for `http.request.method` visible on the `http.server.request.duration` metric card |
| 8 | `custom.*` signals do not appear anywhere in broken tab |
| 9 | Filtering by "spans" shows only span cards |
| 10 | Zero-count metric pill is dimmed and non-clickable |
| 11 | Cards with violations expanded by default |

---