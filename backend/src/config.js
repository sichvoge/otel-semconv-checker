'use strict';

// Loads semconv-checker.config.yaml and normalises it to the shape the API and
// the report transform expect. Every field defaults to [] when absent, so a
// missing config file is valid (GET /api/config just returns empty lists).

const fs = require('node:fs');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.SEMCONV_CONFIG_PATH || '/app/semconv-checker.config.yaml';

const DEFAULTS = Object.freeze({
  custom_namespaces: [],
  expected_metrics: [],
  ignored_metrics: [],
  namespaces: [],
  expected_violations: [],
});

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.length > 0);
}

function normaliseViolations(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === 'object' && typeof x.id === 'string')
    .map((x) => ({
      id: x.id,
      context: x.context && typeof x.context === 'object' ? x.context : {},
      reason: typeof x.reason === 'string' ? x.reason.trim() : '',
    }));
}

function loadConfig(pathOverride) {
  const p = pathOverride || CONFIG_PATH;
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }

  const doc = yaml.load(raw) || {};
  return {
    custom_namespaces: asStringArray(doc.custom_namespaces),
    expected_metrics: asStringArray(doc.expected_metrics),
    ignored_metrics: asStringArray(doc.ignored_metrics),
    namespaces: asStringArray(doc.namespaces),
    expected_violations: normaliseViolations(doc.expected_violations),
  };
}

module.exports = { loadConfig, CONFIG_PATH, DEFAULTS };
