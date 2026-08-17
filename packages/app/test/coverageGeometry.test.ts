/**
 * 涵蓋多邊形的幾何合法性。
 *
 * 這組測試存在的理由是一個實際發生過的 bug：地形把部分方位完全遮蔽時，
 * 早期版本把那些方位畫成「半徑 0 的頂點」，導致外環與最小射程的洞各有
 * 數百個點塌在陣地中心。MapLibre 三角化後吐出大量重疊三角形，
 * 每個都疊一次 fill-opacity —— 畫面上就是一坨黑塊。
 *
 * 沒有測試守著的話，任何一次「順手把扇區邏輯簡化掉」都會讓它復發，
 * 而且只在低空 + 有地形時才看得出來。
 */

import { describe, it, expect } from 'vitest';
import type { MvaField } from '@anti-air/engine';
import { buildCoverageGeoJSON } from '../src/map/coverage';
import type { MvaEntry, Site } from '../src/state/store';

const CENTER = { lon: 120.58, lat: 24.26 };

const site: Site = {
  id: 's1',
  systemId: 'tk3',
  name: '測試陣地',
  lon: CENTER.lon,
  lat: CENTER.lat,
  groundElevationM: 0,
  elevationSource: 'manual',
  status: 'ready',
  readyRoundsOverride: null,
};

/**
 * 合成一個 MVA 場：指定方位區間被一道極高的牆完全遮蔽。
 * 直接組場而不是跑 computeMvaField，是為了讓「被遮蔽的方位」完全可控。
 */
function blockedField(blockedFrom: number, blockedTo: number): MvaField {
  const azimuthCount = 720;
  const rangeBins = 600;
  const rangeStepM = 200;
  const data = new Float32Array(azimuthCount * rangeBins);
  for (let ia = 0; ia < azimuthCount; ia++) {
    const az = (ia * 360) / azimuthCount;
    const blocked =
      blockedFrom <= blockedTo
        ? az >= blockedFrom && az <= blockedTo
        : az >= blockedFrom || az <= blockedTo;
    for (let ir = 0; ir < rangeBins; ir++) {
      // 遮蔽方位給一個高到任何目標都達不到的門檻
      data[ia * rangeBins + ir] = blocked ? 90_000 : 0;
    }
  }
  return {
    center: CENTER,
    siteElevationM: 8,
    azimuthCount,
    rangeBins,
    rangeStepM,
    kFactor: 4 / 3,
    data,
  };
}

function build(field: MvaField | null, altitudeM: number) {
  const mvaBySite: Record<string, MvaEntry> = field
    ? { s1: { key: 'k', status: 'ready', field } }
    : {};
  return buildCoverageGeoJSON([site], new Set(), {
    altitudeM,
    estimateMode: 'nominal',
    aspect: 'head_on',
    mvaBySite,
    terrainEnabled: true,
  });
}

/** 大圓距離 (m)。 */
function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const D = Math.PI / 180;
  const dp = (b[1] - a[1]) * D;
  const dl = (b[0] - a[0]) * D;
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(a[1] * D) * Math.cos(b[1] * D) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function allRings(fc: ReturnType<typeof build>): number[][][] {
  const out: number[][][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const poly of polys) for (const ring of poly) out.push(ring);
  }
  return out;
}

/** 落在陣地中心 100 m 內的頂點數。這正是黑塊的成因指標。 */
function centerVertexCount(fc: ReturnType<typeof build>): number {
  let n = 0;
  for (const ring of allRings(fc)) {
    for (const pt of ring) {
      if (distanceM([CENTER.lon, CENTER.lat], pt as [number, number]) < 100) n++;
    }
  }
  return n;
}

describe('無地形時的涵蓋幾何', () => {
  const fc = build(null, 5000);

  it('產生單一 Polygon（外環 + 最小射程洞）', () => {
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe('Polygon');
    expect((fc.features[0].geometry as GeoJSON.Polygon).coordinates).toHaveLength(2);
  });

  it('沒有任何頂點塌在陣地中心', () => {
    expect(centerVertexCount(fc)).toBe(0);
  });

  it('每個環都是閉合的', () => {
    for (const ring of allRings(fc)) {
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
  });
});

describe('部分方位被地形完全遮蔽', () => {
  // 東側 60°–150° 全遮
  const fc = build(blockedField(60, 150), 100);

  it('改用 MultiPolygon 表達扇區，而不是半徑 0 的頂點', () => {
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.type).toBe('MultiPolygon');
  });

  it('沒有任何頂點塌在陣地中心 —— 黑塊 bug 的直接迴歸守衛', () => {
    expect(centerVertexCount(fc)).toBe(0);
  });

  it('被遮蔽方位上沒有任何頂點', () => {
    for (const ring of allRings(fc)) {
      for (const pt of ring) {
        const dx = (pt[0] - CENTER.lon) * Math.cos(CENTER.lat * (Math.PI / 180));
        const dy = pt[1] - CENTER.lat;
        const az = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        // 邊界處留 2° 容差
        expect(az > 62 && az < 148).toBe(false);
      }
    }
  });

  it('未遮蔽方位仍有實際涵蓋', () => {
    const radii = allRings(fc)
      .flat()
      .map((pt) => distanceM([CENTER.lon, CENTER.lat], pt as [number, number]));
    expect(Math.max(...radii)).toBeGreaterThan(20_000);
  });
});

describe('跨 0° 的遮蔽區間', () => {
  // 遮蔽 350°–20°，可視區是連續的 20°–350°，不該被切成兩塊
  const fc = build(blockedField(350, 20), 100);

  it('可視區合併成單一扇區而不是兩塊', () => {
    const g = fc.features[0].geometry as GeoJSON.MultiPolygon;
    expect(g.type).toBe('MultiPolygon');
    expect(g.coordinates).toHaveLength(1);
  });

  it('仍然沒有中心頂點', () => {
    expect(centerVertexCount(fc)).toBe(0);
  });
});

describe('完全遮蔽', () => {
  const fc = build(blockedField(0, 360), 100);

  it('不產生任何多邊形，而不是退化幾何', () => {
    expect(fc.features).toHaveLength(0);
  });
});
