/**
 * 包絡內插與涵蓋合成的測試。
 *
 * 這裡的重點不是「函式跑得動」，而是 DESIGN.md §10 Phase 1 的驗收條件：
 * 天弓三型在 100 m 與 10 km 的涵蓋半徑差異必須正確，且低空必須是地平線在限制、
 * 而不是運動學在限制 —— 那正是「涵蓋不是圓」的第一個可觀測後果。
 */

import { describe, it, expect } from 'vitest';
import tk3Json from '../../../data/systems/tk3.json';
import gun35Json from '../../../data/systems/gun35.json';
import { kinematicRange, peakRangeM } from '../src/envelope.js';
import { computeCoverage } from '../src/coverage.js';
import { radarHorizonRangeM } from '../src/mva.js';
import { resolve } from '../src/estimate.js';
import type { WeaponSystem } from '../src/system.js';

const tk3 = tk3Json as unknown as WeaponSystem;
const gun35 = gun35Json as unknown as WeaponSystem;

describe('estimate.resolve', () => {
  const e = { min: 15, nominal: 25, max: 40, confidence: 'low' as const };

  it('nominal 永遠取標稱值', () => {
    expect(resolve(e, 'nominal', 'higher')).toBe(25);
    expect(resolve(e, 'nominal', 'lower')).toBe(25);
  });

  it('保守估計對「越大越好」的量取 min', () => {
    expect(resolve(e, 'conservative', 'higher')).toBe(15);
    expect(resolve(e, 'optimistic', 'higher')).toBe(40);
  });

  it('保守估計對「越小越好」的量取 max（方向相反）', () => {
    expect(resolve(e, 'conservative', 'lower')).toBe(40);
    expect(resolve(e, 'optimistic', 'lower')).toBe(15);
  });

  it('缺 min/max 時退回 nominal，不會變成 undefined', () => {
    const bare = { nominal: 10, confidence: 'low' as const };
    expect(resolve(bare, 'conservative', 'higher')).toBe(10);
    expect(resolve(bare, 'optimistic', 'higher')).toBe(10);
  });
});

describe('kinematicRange 內插', () => {
  it('落在表上的高度直接取表值', () => {
    expect(kinematicRange(tk3, 5000)!.rMaxM).toBeCloseTo(150_000, 0);
    expect(kinematicRange(tk3, 20_000)!.rMaxM).toBeCloseTo(200_000, 0);
  });

  it('表間高度線性內插（5 km 與 10 km 的中點）', () => {
    // 150 km @ 5 km、185 km @ 10 km → 7.5 km 應為 167.5 km
    expect(kinematicRange(tk3, 7500)!.rMaxM).toBeCloseTo(167_500, 0);
  });

  it('超過表上界時夾住，絕不外插', () => {
    // 表最高點是 20 km / 200 km；30 km 仍應是 200 km 而非更遠
    expect(kinematicRange(tk3, 30_000)!.rMaxM).toBeCloseTo(200_000, 0);
  });

  it('超出 alt_limits 回傳 null', () => {
    expect(kinematicRange(tk3, 50_000)).toBeNull(); // max 45 km
    expect(kinematicRange(tk3, 10)).toBeNull(); // min 50 m
    expect(kinematicRange(gun35, 5000)).toBeNull(); // 快砲上限 4 km
  });

  it('保守 / 樂觀模式改變半徑，且方向正確', () => {
    const c = kinematicRange(tk3, 5000, 'conservative')!.rMaxM;
    const n = kinematicRange(tk3, 5000, 'nominal')!.rMaxM;
    const o = kinematicRange(tk3, 5000, 'optimistic')!.rMaxM;
    expect(c).toBeLessThan(n);
    expect(n).toBeLessThan(o);
    expect(c).toBeCloseTo(120_000, 0);
    expect(o).toBeCloseTo(180_000, 0);
  });

  it('尾追顯著縮短射程', () => {
    const head = kinematicRange(tk3, 5000, 'nominal', 'head_on')!.rMaxM;
    const tail = kinematicRange(tk3, 5000, 'nominal', 'tail_chase')!.rMaxM;
    expect(tail / head).toBeCloseTo(0.45, 2);
  });

  it('最小射程死區有被讀出來', () => {
    expect(kinematicRange(tk3, 100)!.rMinM).toBeCloseTo(5000, 0);
  });

  it('peakRangeM 抓到整個包絡的最大值', () => {
    expect(peakRangeM(tk3)).toBeCloseTo(200_000, 0);
  });
});

describe('computeCoverage：Phase 1 驗收', () => {
  const atSeaLevel = { siteGroundElevationM: 0, azimuthCount: 72 };

  it('天弓三型打 100 m 低空目標時，限制因素是地平線而非運動學', () => {
    const cov = computeCoverage({ system: tk3, altitudeM: 100, ...atSeaLevel })!;
    expect(cov.empty).toBe(false);
    expect(cov.limitedBy).toBe('horizon');
    expect(cov.horizonMaxM).toBeLessThan(cov.kinematicMaxM);
  });

  it('天弓三型打 100 m 目標的實際半徑約 53 km，遠小於標稱 200 km', () => {
    const cov = computeCoverage({ system: tk3, altitudeM: 100, ...atSeaLevel })!;
    const km = cov.outerM[0] / 1000;
    // 天線 8 m + 目標 100 m → 4.12(√8 + √100) ≈ 52.9 km，
    // 而運動學在此高度仍有 70 km，所以是地平線先咬死。
    expect(km).toBeCloseTo(52.9, 0);
    expect(km).toBeLessThan(cov.kinematicMaxM / 1000);
  });

  it('同一組陣地在 10 km 高度的半徑遠大於 100 m 高度，且限制因素不同', () => {
    const low = computeCoverage({ system: tk3, altitudeM: 100, ...atSeaLevel })!;
    const high = computeCoverage({ system: tk3, altitudeM: 10_000, ...atSeaLevel })!;
    expect(high.outerM[0] / low.outerM[0]).toBeGreaterThan(3);
    // 低空被地平線切，高空被運動學切 —— 兩條鏈分開算才看得到這件事。
    expect(low.limitedBy).toBe('horizon');
    expect(high.limitedBy).toBe('kinematics');
  });

  it('高度超出系統上限時完全無涵蓋', () => {
    const cov = computeCoverage({ system: gun35, altitudeM: 8000, ...atSeaLevel })!;
    expect(cov.empty).toBe(true);
  });

  it('陣地架在山上會延伸地平線', () => {
    const sea = computeCoverage({ system: tk3, altitudeM: 200, siteGroundElevationM: 0 })!;
    const mountain = computeCoverage({ system: tk3, altitudeM: 200, siteGroundElevationM: 1000 })!;
    expect(mountain.horizonMaxM).toBeGreaterThan(sea.horizonMaxM);
    // 1000 m 山頭對 200 m 目標：4.12(√1008 + √200) ≈ 189 km
    expect(mountain.horizonMaxM / 1000).toBeCloseTo(
      radarHorizonRangeM(1008, 200) / 1000,
      0,
    );
  });

  it('每個方位角都有值，且 Phase 1 下彼此相同（尚無地形）', () => {
    const cov = computeCoverage({ system: tk3, altitudeM: 5000, ...atSeaLevel })!;
    expect(cov.outerM.length).toBe(72);
    for (let i = 1; i < cov.outerM.length; i++) {
      expect(cov.outerM[i]).toBeCloseTo(cov.outerM[0], 6);
    }
  });

  it('內半徑不會超過外半徑', () => {
    const cov = computeCoverage({ system: tk3, altitudeM: 100, ...atSeaLevel })!;
    expect(cov.innerM[0]).toBeLessThanOrEqual(cov.outerM[0]);
  });
});
