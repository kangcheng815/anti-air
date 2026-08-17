/**
 * 航跡與時間切片的 GeoJSON 建構。
 *
 * 與 coverage.ts 同一個分工原則：這裡只做「狀態 → 幾何」，
 * 不碰 MapLibre，也不做任何接戰判定。
 */

import type { ContactSnapshot, MissileSnapshot } from '../analysis/timelineModel';
import type { ThreatTrack } from '../state/store';

export const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * 航跡線。只有兩個點以上才畫得出線；正在畫的第一個點會另外以端點圖層呈現，
 * 否則使用者點下第一點後畫面上什麼都不會出現，會以為沒點到。
 */
export function buildTrackGeoJSON(
  tracks: ThreatTrack[],
  selectedId: string | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const t of tracks) {
    if (t.path.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { trackId: t.id, name: t.name, selected: t.id === selectedId },
        geometry: { type: 'LineString', coordinates: t.path },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** 航跡端點：起點（進入）與終點（目標區）在意義上完全不同，分開標。 */
export function buildTrackNodeGeoJSON(
  tracks: ThreatTrack[],
  selectedId: string | null,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (const t of tracks) {
    t.path.forEach(([lon, lat], i) => {
      const role = i === 0 ? 'start' : i === t.path.length - 1 && t.path.length > 1 ? 'end' : 'via';
      features.push({
        type: 'Feature',
        properties: { trackId: t.id, role, selected: t.id === selectedId },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
    });
  }
  return { type: 'FeatureCollection', features };
}

export function buildContactGeoJSON(
  contacts: ContactSnapshot[],
): GeoJSON.FeatureCollection {
  // 漏網的排在後面，才會畫在最上層。
  // 架次間隔為 0 時所有接觸疊在同一點，若讓被接戰的蓋住漏網的，
  // 整張圖就會剛好把唯一該看見的那件事藏起來。
  const ordered = [...contacts].sort(
    (a, b) => Number(a.leakReason !== null) - Number(b.leakReason !== null),
  );

  return {
    type: 'FeatureCollection',
    features: ordered.map((c) => ({
      type: 'Feature',
      properties: {
        contactId: c.contactId,
        // 沒被接戰的目標要一眼看得出來，它才是這張圖的重點。
        state: c.engaged ? 'engaged' : c.leakReason ? 'leaked' : 'pending',
        altitudeM: Math.round(c.altitudeM),
      },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  };
}

export function buildMissileGeoJSON(missiles: MissileSnapshot[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: missiles.map((m) => ({
      type: 'Feature',
      properties: { siteId: m.siteId, contactId: m.contactId },
      geometry: { type: 'LineString', coordinates: [m.from, m.now] },
    })),
  };
}
