/**
 * 航跡幾何測試。
 *
 * 這一層看起來很簡單，但它決定了後面每一個時間數字的正確性：
 * 位置錯 1 km，射擊機會的判定就可能差一次。
 */

import { describe, it, expect } from 'vitest';
import {
  contactPositionAt,
  expandContacts,
  positionAlong,
  trackGeometry,
  type Track,
} from '../src/track.js';
import { bearingDistance, destination } from '../src/geodesy.js';

const START = { lon: 121.5, lat: 24.5 };

/** 由 START 往正西 200 km 的直線航跡，定速 250 m/s，高度 100 m。 */
function straightTrack(overrides: Partial<Track> = {}): Track {
  const end = destination(START, 270, 200_000);
  return {
    id: 't1',
    waypoints: [
      { ...START, altitudeM: 100 },
      { lon: end.lon, lat: end.lat, altitudeM: 100 },
    ],
    speedMps: 250,
    count: 1,
    spacingS: 0,
    startTimeS: 0,
    ...overrides,
  };
}

describe('航跡幾何', () => {
  const track = straightTrack();
  const geom = trackGeometry(track);

  it('總長度等於指定的 200 km（誤差 < 0.5%）', () => {
    expect(geom.totalM / 1000).toBeGreaterThan(199);
    expect(geom.totalM / 1000).toBeLessThan(201);
  });

  it('全程時間 = 長度 / 速度', () => {
    expect(geom.durationS).toBeCloseTo(geom.totalM / 250, 6);
  });

  it('中點與兩端的距離相等', () => {
    const mid = positionAlong(track, geom, geom.totalM / 2);
    const dA = bearingDistance(track.waypoints[0], mid).distanceM;
    const dB = bearingDistance(track.waypoints[1], mid).distanceM;
    expect(Math.abs(dA - dB)).toBeLessThan(200); // 200 km 航跡上 200 m 容差
  });

  it('超出兩端時夾住而不外插', () => {
    const before = positionAlong(track, geom, -50_000);
    const after = positionAlong(track, geom, geom.totalM + 50_000);
    expect(bearingDistance(track.waypoints[0], before).distanceM).toBeLessThan(1);
    expect(bearingDistance(track.waypoints[1], after).distanceM).toBeLessThan(1);
  });

  it('高度沿航段線性內插 —— 下降突防航跡', () => {
    const desc = straightTrack();
    desc.waypoints[0].altitudeM = 8000;
    desc.waypoints[1].altitudeM = 100;
    const g = trackGeometry(desc);
    expect(positionAlong(desc, g, g.totalM / 2).altitudeM).toBeCloseTo(4050, 0);
  });
});

describe('多航段航跡', () => {
  // 西行 100 km 後轉北行 100 km
  const west = destination(START, 270, 100_000);
  const north = destination(west, 0, 100_000);
  const track: Track = {
    id: 'dogleg',
    waypoints: [
      { ...START, altitudeM: 5000 },
      { lon: west.lon, lat: west.lat, altitudeM: 2000 },
      { lon: north.lon, lat: north.lat, altitudeM: 200 },
    ],
    speedMps: 200,
    count: 1,
    spacingS: 0,
    startTimeS: 0,
  };
  const geom = trackGeometry(track);

  it('累積距離逐段遞增', () => {
    expect(geom.cumM[0]).toBe(0);
    expect(geom.cumM[1]).toBeGreaterThan(99_000);
    expect(geom.cumM[2]).toBeGreaterThan(198_000);
  });

  it('轉折點的位置與高度都對得上', () => {
    const p = positionAlong(track, geom, geom.cumM[1]);
    expect(bearingDistance({ lon: west.lon, lat: west.lat }, p).distanceM).toBeLessThan(100);
    expect(p.altitudeM).toBeCloseTo(2000, 0);
  });

  it('第二段的高度用該段的端點內插，而不是全程的', () => {
    const p = positionAlong(track, geom, (geom.cumM[1] + geom.cumM[2]) / 2);
    expect(p.altitudeM).toBeCloseTo(1100, 0); // 2000 與 200 的中點
  });
});

describe('波次展開', () => {
  const track = straightTrack({ count: 4, spacingS: 30, startTimeS: 10 });
  const geom = trackGeometry(track);
  const contacts = expandContacts(track, geom);

  it('展開成 count 個接觸，依 spacing 錯開', () => {
    expect(contacts).toHaveLength(4);
    expect(contacts.map((c) => c.entryTimeS)).toEqual([10, 40, 70, 100]);
  });

  it('每個接觸的抵達時間 = 進入時間 + 全程時間', () => {
    for (const c of contacts) {
      expect(c.arrivalTimeS - c.entryTimeS).toBeCloseTo(geom.durationS, 6);
    }
  });

  it('尚未進入或已抵達時位置為 null —— 目標不存在，不是停在原地', () => {
    const c = contacts[1]; // entry 40
    expect(contactPositionAt(track, geom, c, 39)).toBeNull();
    expect(contactPositionAt(track, geom, c, 40)).not.toBeNull();
    expect(contactPositionAt(track, geom, c, c.arrivalTimeS)).not.toBeNull();
    expect(contactPositionAt(track, geom, c, c.arrivalTimeS + 0.1)).toBeNull();
  });

  it('同一時刻各架次的間距 = 速度 × spacing', () => {
    const t = 300;
    const p0 = contactPositionAt(track, geom, contacts[0], t)!;
    const p1 = contactPositionAt(track, geom, contacts[1], t)!;
    expect(bearingDistance(p0, p1).distanceM).toBeCloseTo(250 * 30, -2);
  });

  it('spacing 為 0 時全部重疊 —— 真正的同時飽和', () => {
    const sim = straightTrack({ count: 3, spacingS: 0 });
    const g = trackGeometry(sim);
    const cs = expandContacts(sim, g);
    expect(new Set(cs.map((c) => c.entryTimeS)).size).toBe(1);
  });
});
