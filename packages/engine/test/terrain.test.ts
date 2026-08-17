/**
 * 真實 DEM 測試。
 *
 * 合成地形（一道牆）只能證明公式沒寫錯；只有真實圖磚能證明
 * 投影 → 圖磚索引 → 解碼 → 內插這一整條鏈沒接歪。接歪的典型症狀是
 * 「看起來有山，但位置偏了幾公里」，那種錯誤用合成資料永遠抓不到。
 *
 * 需要先跑 `node tools/fetch-terrain.mjs`。沒有地形資料時整組跳過。
 */

import { describe, it, expect } from 'vitest';
import {
  computeMvaField,
  mvaAt,
  visibleRangeAtAltitude,
  curvatureDrop,
} from '../src/mva.js';
import { groundResolutionM, tilesCovering } from '../src/terrain.js';
import { samplerFor, terrainAvailable, TERRAIN_ZOOM } from './helpers/loadTiles.js';

const hasTerrain = terrainAvailable();
const suite = hasTerrain ? describe : describe.skip;

if (!hasTerrain) {
  console.warn('[terrain.test] 找不到地形圖磚，跳過。先執行 node tools/fetch-terrain.mjs');
}

suite('DEM 解碼與取樣', () => {
  const YUSHAN = { lon: 120.9574, lat: 23.47 };
  const sampler = samplerFor(YUSHAN, 30_000);

  it('玉山主峰高程接近 3952 m（70 m 網格抓不到尖峰，容許低估）', () => {
    // 取周邊最大值：單點取樣很容易落在峰頂旁的陡坡上。
    let peak = 0;
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        peak = Math.max(peak, sampler.elevationAt(YUSHAN.lon + dx * 0.0007, YUSHAN.lat + dy * 0.0007));
      }
    }
    expect(peak).toBeGreaterThan(3700);
    expect(peak).toBeLessThan(4000);
  });

  it('台灣海峽為 0（海床測深值必須被夾掉）', () => {
    const sea = samplerFor({ lon: 119.5, lat: 24.0 }, 5000);
    expect(sea.elevationAt(119.5, 24.0)).toBe(0);
  });

  it('缺磚會被記錄，不會靜默當成平地', () => {
    const s = samplerFor({ lon: 120.9574, lat: 23.47 }, 1000);
    s.elevationAt(100, 0); // 遠在圖磚範圍外
    expect(s.missingTiles.size).toBeGreaterThan(0);
  });

  it('z11 在台灣緯度的地面解析度約 70 m', () => {
    expect(groundResolutionM(23.5, TERRAIN_ZOOM)).toBeCloseTo(70.1, 0);
  });

  it('tilesCovering 對 100 km 半徑給出合理的圖磚數', () => {
    const keys = tilesCovering(YUSHAN, 100_000, TERRAIN_ZOOM);
    // z11 圖磚在此緯度約 17.9 km 寬 → 200/17.9 ≈ 11~13 格見方
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.length).toBeLessThan(260);
  });
});

suite('Phase 2 驗收：中央山脈造成的東西向不對稱', () => {
  /** 台中近海的平原陣地。西面台灣海峽開闊，東面正對中央山脈。 */
  const SITE = { lon: 120.58, lat: 24.26 };
  const MAX_RANGE = 100_000;

  const sampler = samplerFor(SITE, MAX_RANGE);
  const field = computeMvaField(SITE, sampler, {
    antennaHeightM: 30,
    maxRangeM: MAX_RANGE,
    rangeStepM: 200,
    azimuthCount: 720,
  });

  const ranges100m = visibleRangeAtAltitude(field, 100);
  const az = (deg: number) => Math.round((deg / 360) * 720);

  it('西向（海面）100 m 目標可視距離接近理論地平線', () => {
    // 陣地地面高程約數十公尺，加天線 30 m，對 100 m 目標的地平線約 70–90 km。
    const westKm = ranges100m[az(270)] / 1000;
    expect(westKm).toBeGreaterThan(55);
  });

  it('東向（中央山脈）100 m 目標可視距離被壓到極短', () => {
    const eastKm = ranges100m[az(90)] / 1000;
    expect(eastKm).toBeLessThan(30);
  });

  it('東西不對稱是數量級的差距，不是幾成', () => {
    const westKm = ranges100m[az(270)] / 1000;
    const eastKm = ranges100m[az(90)] / 1000;
    expect(westKm / eastKm).toBeGreaterThan(3);
  });

  it('東向 60 km 處的最低可視高度是公里級，遠高於曲率單獨造成的下沉', () => {
    const mva = mvaAt(field, 90, 60_000);
    const curvatureOnly = curvatureDrop(60_000); // ≈ 212 m
    expect(mva).toBeGreaterThan(1500);
    expect(mva).toBeGreaterThan(curvatureOnly * 5);
  });

  it('高空目標不受地形影響：15 km 高度時東西向可視距離接近', () => {
    const r15k = visibleRangeAtAltitude(field, 15_000);
    const west = r15k[az(270)];
    const east = r15k[az(90)];
    // 兩邊都應該打滿計算上限
    expect(west).toBeGreaterThan(MAX_RANGE * 0.95);
    expect(east).toBeGreaterThan(MAX_RANGE * 0.95);
  });

  it('可視高度隨目標高度單調放寬（拉高一定不會變得更看不到）', () => {
    let prev = 0;
    for (const alt of [100, 500, 1000, 3000, 8000, 15_000]) {
      const total = visibleRangeAtAltitude(field, alt).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
  });
});
