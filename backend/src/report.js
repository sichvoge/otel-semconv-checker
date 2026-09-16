'use strict';

// Parses Weaver's live_check.json into the API's report shape.
//
// Weaver writes an OBJECT (not a flat array):
//   { "samples": [ { <sampleType>: <obj> }, ... ], "statistics": { ... } }
//
// Each samples[] entry is a single-key wrapper keyed by sample type
// (`resource`, `instrumentation_scope`, `span`, `log`, `metric`, ...). The
// wrapped object carries the signal name, its attributes, nested data points,
// and `live_check_result` objects at whichever level a finding applies. The
// frontend walks this tree recursively; the backend passes it through as
// `entities`, plus a derived `missing` list.

// Recursively collect every PolicyFinding embedded in a sample subtree.
function collectFindings(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectFindings(item, out);
    return out;
  }
  const lcr = node.live_check_result;
  if (lcr && Array.isArray(lcr.all_advice)) {
    for (const advice of lcr.all_advice) out.push(advice);
  }
  for (const key of Object.keys(node)) {
    if (key === 'live_check_result') continue;
    collectFindings(node[key], out);
  }
  return out;
}

// The namespace scope for the missing tab: `namespaces` from config when set,
// otherwise auto-detected from the first segment of every registry metric /
// attribute that was actually seen (count > 0). SPEC § Configuration.
function activeNamespaces(stats, config) {
  const configured = Array.isArray(config.namespaces) ? config.namespaces.filter(Boolean) : [];
  if (configured.length) return new Set(configured);

  const ns = new Set();
  const scan = (map) => {
    for (const [name, count] of Object.entries(map || {})) {
      if (count > 0 && name.includes('.')) ns.add(name.slice(0, name.indexOf('.')));
    }
  };
  scan(stats.seen_registry_metrics);
  scan(stats.seen_registry_attributes);
  return ns;
}

// Registry metrics that semconv defines for the observed traffic pattern but
// that were never emitted this session. SPEC § Tabs / what is missing?.
function computeMissing(stats, config, metricRequirements) {
  const seen = (stats && stats.seen_registry_metrics && typeof stats.seen_registry_metrics === 'object')
    ? stats.seen_registry_metrics : {};
  const reqs = metricRequirements || {};
  const active = activeNamespaces(stats || {}, config);
  const expected = new Set(config.expected_metrics || []);
  const ignored = new Set(config.ignored_metrics || []);

  const candidates = new Set();
  for (const [name, count] of Object.entries(seen)) {
    if (count > 0 || !name.includes('.')) continue;
    if (active.has(name.slice(0, name.indexOf('.')))) candidates.add(name);
  }
  // expected_metrics are surfaced even when opt-in or in an inactive namespace,
  // as long as they were never emitted.
  for (const name of expected) {
    if ((seen[name] || 0) === 0) candidates.add(name);
  }

  const cards = [];
  for (const name of candidates) {
    if (ignored.has(name)) continue;

    const req = reqs[name];
    const level = req ? req.requirement_level : 'recommended';
    // opt-in metrics never appear in the missing tab unless explicitly expected.
    if (level === 'opt_in' && !expected.has(name)) continue;

    const attributes = (req ? req.attributes : [])
      .filter((a) => a.requirement_level === 'required' || a.requirement_level === 'recommended')
      .map((a) => ({ name: a.name, requirement_level: a.requirement_level }));

    cards.push({
      name,
      signal_type: 'metric',
      stability: req ? req.stability : 'development',
      requirement_level: level,
      attributes,
    });
  }

  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

function parseReport(raw, config = {}, metricRequirements = {}) {
  const samples = raw && Array.isArray(raw.samples) ? raw.samples : [];
  const stats = raw && raw.statistics && typeof raw.statistics === 'object' ? raw.statistics : {};

  return {
    entities: samples,
    stats,
    missing: computeMissing(stats, config, metricRequirements),
  };
}

module.exports = { parseReport, collectFindings, computeMissing };
