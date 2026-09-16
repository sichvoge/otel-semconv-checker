#!/usr/bin/env node
/*
 * fetch-metric-requirements.js — run on demand:  npm run fetch-metric-requirements
 *
 * Scrapes the official OpenTelemetry semantic-conventions repo to extract, for
 * every metric defined in the spec:
 *   - its requirement level  ("required" | "recommended" | "opt_in")
 *   - its stability          ("stable" | "development" | "deprecated")
 *   - its attributes and each attribute's requirement level
 *
 * Writes backend/src/data/metric-requirements.json. The backend reads that file
 * at startup to label / filter never-emitted metrics in the "what is missing?"
 * tab (SPEC § Scripts). Do not edit the JSON by hand — regenerate it.
 *
 * How it works:
 *   1. GitHub tree API -> every docs/**​/*-metrics.md path
 *   2. raw.githubusercontent.com -> each file
 *   3. Parse the very regular per-metric section:
 *        ### Metric: `name`
 *        This metric is [<level>]...
 *        | Name | Instrument Type | ... | Stability | ...
 *        | `name` | Histogram | s | ... | ![Stable](...) | |
 *        ...
 *        | Key | Stability | [Requirement Level](...) | ...
 *        | [`attr.key`](...) | ![Stable](...) | `Required` ... | ...
 *   4. Write the JSON + print a summary
 *
 * Output shape (SPEC § Scripts):
 *   {
 *     "generated_at": ISO, "semconv_version": "main", "source": URL,
 *     "metrics":  { "<name>": "required" | "recommended" | "opt_in" },   // SPEC form
 *     "details":  { "<name>": { "stability": "...", "attributes": [ {name, requirement_level} ] } }
 *   }
 * `metrics` is exactly the flat map SPEC documents. `details` is additive — the
 * missing tab needs the stability badge and attribute chips, which the flat
 * value cannot carry. The backend loader merges the two.
 *
 * Flags:
 *   --out <path>   write somewhere other than src/data/metric-requirements.json
 *   --stdout       print the JSON to stdout, write nothing
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'open-telemetry/semantic-conventions';
const REF = 'main';
const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`;
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/${REF}/${p}`;
const OUT = path.join(__dirname, '..', 'src', 'data', 'metric-requirements.json');

const METRIC_HEADER = /^#{2,4}\s+Metric:\s+`([^`]+)`/;
const METRIC_LEVEL = /This metric is\s+(?:\[|SHOULD be\s+\[?)?(recommended|opt[- ]in|required|optional)/i;
const STABILITY_BADGE = /!\[(Stable|Development|Experimental|Deprecated|Alpha|Beta|Release Candidate)\]/i;
const ATTR_TABLE_HEADER = /\|\s*Key\s*\|.*Requirement Level/i;
const NAME_TABLE_HEADER = /\|\s*Name\s*\|\s*Instrument Type\s*\|/i;

function normalizeMetricLevel(raw) {
  const s = String(raw).toLowerCase().replace(/\s+/g, '-');
  if (s === 'required') return 'required';
  if (s === 'recommended') return 'recommended';
  if (s === 'opt-in' || s === 'optional') return 'opt_in';
  return 'recommended';
}

function normalizeStability(raw) {
  const s = String(raw).toLowerCase();
  if (s === 'stable') return 'stable';
  if (s === 'deprecated') return 'deprecated';
  return 'development'; // development / experimental / alpha / beta / rc
}

function normalizeAttrLevel(cell) {
  const s = cell.replace(/`/g, '').trim();
  if (/^Conditionally Required/i.test(s)) return 'conditionally_required';
  if (/^Required/i.test(s)) return 'required';
  if (/^Recommended/i.test(s)) return 'recommended';
  if (/^Opt[- ]In/i.test(s)) return 'opt_in';
  return null;
}

// A markdown table row -> trimmed cells (leading/trailing pipe stripped).
function tableCells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function firstBacktickToken(s) {
  const m = s.match(/`([^`]+)`/);
  return m ? m[1] : null;
}

// Parse one docs/**​/*-metrics.md file into { name: {requirement_level, stability, attributes[]} }.
function parseFile(md) {
  const lines = md.split('\n');
  const out = {};
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(METRIC_HEADER);
    if (!header) { i += 1; continue; }
    const name = header[1];

    // Section runs until the next metric header (any level 2-4).
    let end = i + 1;
    while (end < lines.length && !METRIC_HEADER.test(lines[end])) end += 1;
    const section = lines.slice(i, end);

    const entry = { requirement_level: 'recommended', stability: 'development', attributes: [] };

    const levelLine = section.find((l) => METRIC_LEVEL.test(l));
    if (levelLine) entry.requirement_level = normalizeMetricLevel(levelLine.match(METRIC_LEVEL)[1]);

    // Stability: the row of the Name/Instrument table whose first cell is `name`.
    const nameHeaderIdx = section.findIndex((l) => NAME_TABLE_HEADER.test(l));
    if (nameHeaderIdx !== -1) {
      for (let k = nameHeaderIdx + 1; k < section.length && section[k].trim().startsWith('|'); k += 1) {
        const cells = tableCells(section[k]);
        if (firstBacktickToken(cells[0]) === name) {
          const badge = section[k].match(STABILITY_BADGE);
          if (badge) entry.stability = normalizeStability(badge[1]);
          break;
        }
      }
    }

    // Attributes: the rows of the table whose header carries "Requirement Level".
    const attrHeaderIdx = section.findIndex((l) => ATTR_TABLE_HEADER.test(l));
    if (attrHeaderIdx !== -1) {
      // skip the header separator row (|---|---|)
      let k = attrHeaderIdx + 1;
      if (section[k] && /^\s*\|[\s:-]+\|/.test(section[k])) k += 1;
      for (; k < section.length && section[k].trim().startsWith('|'); k += 1) {
        const cells = tableCells(section[k]);
        const key = firstBacktickToken(cells[0]);
        if (!key) continue;
        const level = normalizeAttrLevel(cells[2] || '');
        if (!level) continue;
        entry.attributes.push({ name: key, requirement_level: level });
      }
    }

    // Keep whichever definition carries more attribute detail (the canonical
    // docs/http/... file beats a language-specific re-listing).
    if (!out[name] || entry.attributes.length > out[name].attributes.length) {
      out[name] = entry;
    }

    i = end;
  }

  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'otel-semconv-checker' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'otel-semconv-checker' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

function parseArgs(argv) {
  const args = { out: OUT, stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--stdout') args.stdout = true;
    else if (argv[i].startsWith('--out=')) args.out = argv[i].slice('--out='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.error(`[fetch-metric-requirements] listing ${REPO}@${REF} tree ...`);
  const tree = await getJson(TREE_URL);
  const files = (tree.tree || [])
    .map((n) => n.path)
    .filter((p) => /^docs\/.*metrics.*\.md$/.test(p))
    .sort();
  console.error(`[fetch-metric-requirements] ${files.length} metrics docs to fetch`);

  const parsed = {};
  let fetched = 0;
  const skipped = [];
  for (const p of files) {
    try {
      const md = await getText(RAW(p));
      fetched += 1;
      const fileMetrics = parseFile(md);
      const names = Object.keys(fileMetrics);
      for (const name of names) {
        if (!parsed[name] || fileMetrics[name].attributes.length > parsed[name].attributes.length) {
          parsed[name] = fileMetrics[name];
        }
      }
      console.error(`  ${p}: ${names.length} metric(s)`);
    } catch (err) {
      skipped.push({ path: p, error: err.message });
      console.error(`  ${p}: SKIPPED (${err.message})`);
    }
  }

  const names = Object.keys(parsed).sort();
  const metrics = {};
  const details = {};
  for (const name of names) {
    metrics[name] = parsed[name].requirement_level;
    details[name] = { stability: parsed[name].stability, attributes: parsed[name].attributes };
  }

  const doc = {
    generated_at: new Date().toISOString(),
    semconv_version: REF,
    source: `https://github.com/${REPO}/tree/${REF}/docs`,
    metrics,
    details,
  };
  const json = `${JSON.stringify(doc, null, 2)}\n`;

  if (args.stdout) {
    process.stdout.write(json);
  } else {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json);
  }

  const byLevel = Object.values(metrics).reduce((acc, lvl) => {
    acc[lvl] = (acc[lvl] || 0) + 1;
    return acc;
  }, {});
  console.error('[fetch-metric-requirements] summary:');
  console.error(`  pages fetched: ${fetched}/${files.length}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  console.error(`  metrics found: ${names.length}  by requirement level: ${JSON.stringify(byLevel)}`);
  if (!args.stdout) console.error(`  wrote: ${args.out}`);
}

main().catch((err) => {
  console.error(`[fetch-metric-requirements] FAILED: ${err.stack || err.message}`);
  process.exit(1);
});
