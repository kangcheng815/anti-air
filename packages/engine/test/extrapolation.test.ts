/**
 * MVA 場邊界外推。
 *
 * 這條修正來自剖面圖上看到的實際症狀：中央山脈背後、超出 MVA 場半徑的
 * 低空格點被判為「已偵獲」。原因是場外退回平坦地形地平線，等於假裝山消失了。
 */

import { describe, it, expect } from 'vitest';
import {
  computeMvaField,
  curvatureDrop,
  extrapolatedMvaAt,
  mvaAt,
  mvaExtentM,
  type TerrainSampler,
} from '../src/mva.js';

const ORIGIN = { lon: 121.0, lat: 24.0 };

/** 東邊 20 km 一道 3000 m 的牆。MVA 場只算到 40 km。 */
const ridge: TerrainSampler = {
  elevationAt(lon) {
    const dxKm = (lon - ORIGIN.lon) * 111.32 * Math.cos(24 * (Math.PI / 180));
    return dxKm > 19 && dxKm < 21 ? 3000 : 0;
  },
};

const field = computeMvaField(ORIGIN, ridge, {
  antennaHeightM: 20,
  maxRangeM: 40_000,
  rangeStepM: 100,
  azimuthCount: 360,
});

describe('extrapolatedMvaAt', () => {
  it('場內與 mvaAt 完全一致', () => {
    for (const r of [5_000, 20_000, 39_000]) {
      expect(extrapolatedMvaAt(field, 90, r)).toBe(mvaAt(field, 90, r));
    }
  });

  it('場外沿邊界射線延伸，繼續遮蔽', () => {
    const extent = mvaExtentM(field);
    const edge = mvaAt(field, 90, extent);
    const far = extrapolatedMvaAt(field, 90, 120_000);
    // 射線持續上升，120 km 處的門檻應遠高於 40 km 處
    expect(far).toBeGreaterThan(edge * 2);
  });

  it('外推值符合幾何：邊界射線斜率延長後的高度', () => {
    const extent = mvaExtentM(field);
    const edge = mvaAt(field, 90, extent);
    const tanEdge = (edge - field.siteElevationM - curvatureDrop(extent)) / extent;
    const r = 100_000;
    const expected = field.siteElevationM + r * tanEdge + curvatureDrop(r);
    expect(extrapolatedMvaAt(field, 90, r)).toBeCloseTo(expected, 3);
  });

  it('山背後 100 km 的 2000 m 目標仍被遮蔽（修正前會誤判為可見）', () => {
    // 3000 m 的牆在 20 km 處 → 仰角約 8.5°，100 km 處需 ~14 km 高才看得到
    expect(extrapolatedMvaAt(field, 90, 100_000)).toBeGreaterThan(10_000);
    // 對照：平坦地形地平線在此高度是看得到的，證明差異來自地形而非曲率
    const flatHorizonMva = field.siteElevationM + curvatureDrop(100_000);
    expect(flatHorizonMva).toBeLessThan(1000);
  });

  it('無遮蔽方位的外推等於純曲率，不會憑空製造遮蔽', () => {
    const west = extrapolatedMvaAt(field, 270, 100_000);
    // 平坦海面：邊界射線是負仰角（居高臨下），外推後仍接近地平線值
    expect(west).toBeLessThan(700);
    expect(west).toBeGreaterThan(0);
  });
});
