# OTel SemConv Checker — Phase 5: Frontend — missing tab

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

## Phase 5: Frontend — missing tab

**Outcome:** The "what is missing?" tab renders correctly. Never-emitted
signals from active namespaces appear. Expected attributes shown with
requirement level chips. `expected_metrics` and `ignored_metrics` from
config are respected.

### What to build

- `MissingTab` component
- `MissingCard` with attribute chips (required/recommended/optional)
- Missing signals derived from `seen_registry_metrics` count = 0
- Namespace scoping — only active namespaces evaluated
- `expected_metrics` from config always shown in missing tab
- `ignored_metrics` from config suppressed from missing tab
- `metric-requirements.json` read by backend for requirement level labels
- Missing tab stat card with count, clickable

### QA

Builds on phase 4 stack. Uses phase-05 scenario. The `http` namespace is
already active (the base scenario emits `http.server.request.duration`).

`http.server.request.duration` itself is NOT a gap — it was emitted. Of the
never-emitted `http.*` metrics, the only one that surfaces in the missing tab
is `http.client.request.duration`: it is `recommended` (opt-in metrics are
never shown — see SPEC), `stable`, and carries both required attributes
(`http.request.method`, `server.address`, `server.port`) and a recommended one
(`network.protocol.version`). Every other never-emitted `http.*` metric
(`http.server.active_requests`, `http.*.body.size`, …) is opt-in and only
appears via `expected_metrics`.

The phase-05 `http.request` span is an explicit namespace-activation
belt-and-braces and adds a span-type signal.

#### Assertions — phase 5

| # | Assertion |
|---|-----------|
| 1 | Missing tab visible in tab bar |
| 2 | Missing stat card shows correct count |
| 3 | `http.client.request.duration` card visible in missing tab |
| 4 | `http.client.request.duration` shows a "stable" stability badge |
| 5 | `http.request.method` shown as a required chip (red) on that card |
| 6 | `network.protocol.version` shown as a recommended chip (amber) on that card |
| 7 | A metric listed in the test config's `ignored_metrics` does not appear in the missing tab |
| 8 | A metric listed in the test config's `expected_metrics` (e.g. the opt-in `http.server.active_requests`) still appears in the missing tab |
| 9 | `http.server.request.duration` does NOT appear in the missing tab — it was emitted |
| 10 | Signal filter works — filtering by "metric" shows only metric cards |

---