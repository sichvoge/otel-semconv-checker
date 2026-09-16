# OTel SemConv Checker — Phase 6: Metric requirements script

Reference: `references/SPEC.md`
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

## Phase 6: Metric requirements script

**Outcome:** `scripts/fetch-metric-requirements.js` runs successfully, produces
`src/data/metric-requirements.json` with correct requirement levels for known
metrics, and the backend uses it to label missing metrics correctly in the API.

### What to build

- `scripts/fetch-metric-requirements.js`
- GitHub tree API enumeration of `docs/**/*metrics*.md`
- Raw markdown fetching and prose parsing
- Output: `src/data/metric-requirements.json`
- Backend reads this file at startup, exposes via `GET /api/report` as
  `requirement_level` on each missing metric entry
- `npm run fetch-metric-requirements` script in `package.json`

### QA

Does not require the full stack. Runs the script and validates the output file.
Then starts the stack and validates the API response.

#### Folder structure

```
qa/phase-06-metric-requirements/
├── validate.js
└── expected/
    └── known-metrics.json   # subset of metrics with known requirement levels
```

#### Assertions — phase 6

| # | Assertion |
|---|-----------|
| 1 | `node scripts/fetch-metric-requirements.js` exits 0 |
| 2 | `src/data/metric-requirements.json` exists and is valid JSON |
| 3 | `generated_at` field is a valid ISO timestamp |
| 4 | `metrics` object is non-empty |
| 5 | `http.server.request.duration` → `"recommended"` |
| 6 | `http.client.request.duration` → `"recommended"` |
| 7 | `http.server.active_requests` → `"opt_in"` |
| 8 | No metric has a value outside `"required"`, `"recommended"`, `"opt_in"` |
| 9 | Script summary output lists pages fetched and metrics found |
| 10 | Missing tab in UI shows the `recommended` requirement level on the `http.client.request.duration` card |

---