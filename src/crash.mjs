import fs from 'node:fs';
import path from 'node:path';

import { readText } from './fsx.mjs';

const REPORT_NAME_RE = /^crash-[\dTZ-]+-(?:host|web-boot|renderer|main)\.log$/;

export function listCrashReports(dirs = []) {
  const reports = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !REPORT_NAME_RE.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let stats;
      try {
        stats = fs.statSync(full);
      } catch {
        continue;
      }
      reports.push({ path: full, name: entry.name, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function headerValue(text, key) {
  const match = new RegExp(`^${key}: (.*)$`, 'm').exec(text);
  return match ? match[1].trim() : null;
}

function errorSection(text) {
  const start = text.indexOf('--- error ---');
  if (start === -1) return text;
  const body = text.slice(start + '--- error ---'.length);
  const end = body.search(/^--- /m);
  return end === -1 ? body : body.slice(0, end);
}

/**
 * Pull the handful of facts a human needs out of a DSH crash report.
 * Deliberately tolerant: reports can contain mojibake from GBK output, and a
 * throw here would hide the very failure we are explaining.
 */
export function parseCrashReport(text) {
  const source = typeof text === 'string' ? text : '';
  const section = errorSection(source);
  const facts = {
    time: headerValue(source, 'time'),
    source: headerValue(source, 'source'),
    phase: headerValue(source, 'phase'),
    app: headerValue(source, 'app'),
    node: headerValue(source, 'node'),
    exitCode: null,
    skippedBundles: [],
    incompatible: [],
    entriesFailed: null,
    pending: [],
    title: null,
  };

  const exit = /host exited with (\d+)/.exec(section);
  if (exit) facts.exitCode = Number(exit[1]);

  for (const match of section.matchAll(/skipping profile bundle "([^"]+)"/g)) {
    facts.skippedBundles.push(match[1]);
  }
  for (const match of section.matchAll(/Plugin (\S+?)@(\S+) is incompatible with dsh (\S+?):/g)) {
    facts.incompatible.push({ package: match[1], version: match[2], runtime: match[3] });
  }

  const failed = /warning: (\d+) entr(?:y|ies) did not activate/.exec(section);
  if (failed) facts.entriesFailed = Number(failed[1]);

  for (const match of section.matchAll(/^(\S+) \(([^)]+)\): pending \((.*)\)$/gm)) {
    facts.pending.push({ entry: match[1], package: match[2], reason: match[3] });
  }

  const firstLine = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('at '));
  if (firstLine) facts.title = firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine;

  return facts;
}

export function latestCrash(dirs = []) {
  const reports = listCrashReports(dirs);
  if (reports.length === 0) return null;
  const report = reports[0];
  let text = '';
  try {
    text = readText(report.path) ?? '';
  } catch {
    text = '';
  }
  return { ...report, facts: parseCrashReport(text) };
}