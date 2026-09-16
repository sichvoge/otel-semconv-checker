# OTel SemConv Checker

A web app that wraps `weaver registry live-check` to help teams understand
how well their OTLP instrumentation conforms to OpenTelemetry semantic
conventions.

## Repository layout

```
/
├── CLAUDE.md
├── agents/
│   ├── BUILDER-AGENT.md
│   └── QA-AGENT.md
├── plans/
│   ├── PLAN-phase-01-infrastructure.md
│   └── ... (one file per phase)
├── references/
│   ├── SPEC.md
│   └── prototype-2026-04-15.html
└── qa/
    ├── test-app/
    └── phase-XX-<name>/  (one folder per phase)
```

All paths in agent and plan files are relative to the project root.

## Execution model

```
// One-time setup — before the phase loop
QA agent: check if qa/test-app/ exists
  if not → create test app, verify it runs

// Phase loop
for each phase in plans/:
  builder: read phase plan file, implement
  loop (max 3 attempts):
    QA agent: create qa/phase-XX/ files, run validate.js, report output
    if pass → break
    if fail → builder evaluates output, narrates fix, applies fix, retries
  if max retries hit → stop, report to human
  builder: move to next phase
```

Both agents are verbose by default. See `agents/BUILDER-AGENT.md` and
`agents/QA-AGENT.md` for output format and detailed instructions.
