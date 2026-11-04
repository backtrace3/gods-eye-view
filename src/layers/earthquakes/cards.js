/** Card model for one selected earthquake. Pure — no Cesium types, no i18n. */

export const EARTHQUAKE_CARD_SOURCE_ID = 'earthquake-selection';

/** CSS accent for a quake by depth band (mirrors depthColor in model.js). */
export function depthAccent(depthKm) {
  const depth = Number.isFinite(depthKm) ? depthKm : 0;
  if (depth < 70) return '#ff0000';
  if (depth < 300) return '#ffa500';
  return '#ffff00';
}

/** Compact age: "just now", "12 min ago", "3 h ago", "1 d ago". */
export function formatQuakeAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Plain-language strength band for a magnitude (USGS-style wording). */
export function magnitudeClass(mag) {
  if (!Number.isFinite(mag)) return null;
  if (mag >= 8) return 'Great';
  if (mag >= 7) return 'Major';
  if (mag >= 6) return 'Strong';
  if (mag >= 5) return 'Moderate';
  if (mag >= 4) return 'Light';
  if (mag >= 3) return 'Minor';
  return 'Weak';
}

/**
 * Build the overlay-host entry for one selected earthquake. The caller adds
 * `position` (Cartesian) — this model stays JSON-safe for tests.
 * @param {{stableId: string, mag: number, place: ?string, depthKm: ?number,
 *   time: ?number}} row - Normalized earthquake row (see records.js).
 * @param {number} nowMs - Current epoch milliseconds.
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildEarthquakeCard(row, nowMs) {
  const mag = Number(row.mag);
  const strength = magnitudeClass(mag);
  const facts = [];
  if (strength) facts.push(strength);
  if (Number.isFinite(row.depthKm))
    facts.push(`${Math.round(row.depthKm)} km deep`);
  const age = row.time == null ? null : formatQuakeAge(nowMs - row.time);
  if (age) facts.push(age);

  const details = [];
  if (row.place) details.push(row.place);
  if (facts.length) details.push(facts.join(' · '));
  details.push('Source: USGS');

  return {
    id: `earthquake-card:${row.stableId}`,
    selected: true,
    interactive: false,
    // Portable package (no i18n), like the map's "M4.6" labels. i18n-ignore
    title: `QUAKE · M${Number.isFinite(mag) ? mag.toFixed(1) : '?'}`,
    details,
    accent: depthAccent(row.depthKm),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
