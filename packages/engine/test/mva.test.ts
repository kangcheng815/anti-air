/**
 * MVA 引擎的解析解驗證。
 *
 * 這幾條測試是整個專案的地基：如果 MVA 場算錯，後面所有涵蓋圖、
 * 縱深熱圖、剖面圖都是漂亮的垃圾。所以不測「函式有沒有回傳東西」，
 * 而是拿它跟已知的封閉解對答案。
 */

import { describe, it, expect } from 'vitest';
import {
  computeMvaField,
  curvatureDrop,
  mvaAt,
  visibleRangeAtAltitude,
  EARTH_RADIUS_M,
  DEFAULT_K_FACTOR,
  type TerrainSampler,
} from '../src/mva.js';

/** 全平的海面。高程處處為 0。 */
const flatSea: TerrainSampler = { elevationAt: () => 0 };

/** 教科書雷達地平線：d(km) = 4.12 (√h₁ + √h₂)，h 單位公尺。 */
function textbookHorizonKm(h1M: number, h2M: number): number {
  return 4.12 * (Math.sqrt(h1M) + Math.sqrt(h2M));
}

const TAIPEI = { lon: 121.5, lat: 25.0 };

describe('curvatureDrop', () => {
  it('4/3 地球下，50 km 處的下沉量約 147 m', () => {
    expect(curvatureDrop(50_000)).toBeCloseTo(147.1, 0);
  });

  it('k=1（無折射）時下沉量比 k=4/3 大 4/3 倍', () => {
    expect(curvatureDrop(50_000, 1) / curvatureDrop(50_000, 4 / 3)).toBeCloseTo(4 / 3, 6);
  });
});

describe('computeMvaField 在平坦海面上還原雷達地平線', () => {
  const field = computeMvaField(TAIPEI, flatSea, {
    antennaHeightM: 30,
    maxRangeM: 120_000,
    rangeStepM: 100,
    azimuthCount: 8,
  });

  it.each([
    [30, 100],
    [30, 1_000],
    [10, 100],
    [100, 5_000],
  ])('天線 %i m、目標 %i m：MVA 交點距離符合 4.12 公式', (hRadar, hTarget) => {
    const f = computeMvaField(TAIPEI, flatSea, {
      antennaHeightM: hRadar,
      maxRangeM: 400_000,
      rangeStepM: 100,
      azimuthCount: 4,
    });
    const rangesM = visibleRangeAtAltitude(f, hTarget);
    const gotKm = rangesM[0] / 1000;
    const wantKm = textbookHorizonKm(hRadar, hTarget);
    // 4.12 本身是 √(2kRe)·10⁻³ 的四捨五入近似，容差取 0.5%。
    expect(Math.abs(gotKm - wantKm) / wantKm).toBeLessThan(0.005);
  });

  it('MVA 隨距離單調遞增（平坦地形上不應有回頭）', () => {
    for (let ir = 1; ir < field.rangeBins; ir++) {
      expect(field.data[ir]).toBeGreaterThanOrEqual(field.data[ir - 1] - 1e-6);
    }
  });

  it('各方位角結果一致（平坦地形應為旋轉對稱）', () => {
    const ref = mvaAt(field, 0, 60_000);
    for (const az of [45, 90, 180, 270, 315]) {
      expect(mvaAt(field, az, 60_000)).toBeCloseTo(ref, 3);
    }
  });

  it('4.12 係數本身可由 √(2kRe) 導出', () => {
    const coefficient = Math.sqrt(2 * DEFAULT_K_FACTOR * EARTH_RADIUS_M) / 1000;
    expect(coefficient).toBeCloseTo(4.1218, 3);
  });
});

describe('地形遮蔽', () => {
  /** 東邊 20 km 處有一道高 1500 m 的牆（粗略模擬中央山脈）。 */
  const ridge: TerrainSampler = {
    elevationAt(lon, lat) {
      const dxKm = (lon - TAIPEI.lon) * 111 * Math.cos(TAIPEI.lat * (Math.PI / 180));
      return dxKm > 19 && dxKm < 21 ? 1500 : 0;
    },
  };

  const field = computeMvaField(TAIPEI, ridge, {
    antennaHeightM: 30,
    maxRangeM: 100_000,
    rangeStepM: 100,
    azimuthCount: 360,
  });

  it('山脊背後（正東）的低空被遮蔽，100 m 目標看不到', () => {
    expect(mvaAt(field, 90, 60_000)).toBeGreaterThan(100);
  });

  it('山脊背後 60 km 處的最低可視高度落在幾何延伸的上下界之間', () => {
    // 遮蔽射線一定由山脊的某一點決定。牆佔 19~21 km，
    // 近緣給出最高的遮蔽射線、遠緣最低，實測值必須落在兩者之間。
    const extendTo60km = (ridgeRangeM: number) =>
      30 + 60_000 * ((1500 - curvatureDrop(ridgeRangeM) - 30) / ridgeRangeM) + curvatureDrop(60_000);
    const lower = extendTo60km(21_000); // ≈ 4368 m
    const upper = extendTo60km(19_000); // ≈ 4817 m
    const got = mvaAt(field, 90, 60_000);
    expect(got).toBeGreaterThan(lower);
    expect(got).toBeLessThan(upper);
  });

  it('未被遮蔽的方位（正西）不受影響', () => {
    expect(mvaAt(field, 270, 60_000)).toBeLessThan(400);
  });
});
