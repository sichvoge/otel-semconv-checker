'use strict';

// Loads semconv-checker.config.yaml and normalises it to the shape the API and
// the report transform expect. Every field defaults to [] when absent, so a
// missing config file is valid (GET /api/config just returns empty lists).

const fs = require('node:fs');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.SEMCONV_CONFIG_PATH || '/app/semconv-checker.config.yaml';

const DEFAULTS = Object.freeze({
  expected_metrics: [],
  ignored_metrics: [],
  namespaces: [],
});

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.length > 0);
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
    expected_metrics: asStringArray(doc.expected_metrics),
    ignored_metrics: asStringArray(doc.ignored_metrics),
    namespaces: asStringArray(doc.namespaces),
  };
}

module.exports = { loadConfig, CONFIG_PATH, DEFAULTS };
