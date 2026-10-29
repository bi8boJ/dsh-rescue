import crypto from 'node:crypto';
import path from 'node:path';

import { readText } from './fsx.mjs';

export const BEACON_FILE = 'beacon.json';

/** Must stay byte-compatible with the plugin's `bundlesHash`. */
export function bundlesHash(bundles) {
  return crypto.createHash('sha256').update((bundles ?? []).join('\n')).digest('hex');
}

export function beaconPath(layout) {
  return path.join(layout.rescueDir, BEACON_FILE);
}

export function readBeacon(layout) {
  const text = readText(beaconPath(layout));
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * What the beacon says about "did this configuration actually run", compared
 * with the configuration as it is right now.
 */
export function describeBeacon({ layout, bundles = [], now = Date.now() } = {}) {
  const beacon = readBeacon(layout);
  if (!beacon) return { found: false };
  const hash = bundlesHash(bundles);
  const readyAt = typeof beacon.readyAt === 'string' ? beacon.readyAt : null;
  const ageMs = readyAt ? Math.max(0, now - new Date(readyAt).getTime()) : null;
  return {
    found: true,
    state: typeof beacon.state === 'string' ? beacon.state : 'unknown',
    startedAt: beacon.startedAt ?? null,
    readyAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    delayMs: Number.isFinite(beacon.delayMs) ? beacon.delayMs : null,
    bundlesCount: Number.isFinite(beacon.bundlesCount) ? beacon.bundlesCount : null,
    hashMatches: typeof beacon.bundlesHash === 'string' ? beacon.bundlesHash === hash : false,
    beaconHash: beacon.bundlesHash ?? null,
  };
}