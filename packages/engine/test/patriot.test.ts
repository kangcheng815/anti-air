/**
 * 愛國者二／三型的資料完整性測試。
 *
 * 重點不是重新驗證引擎邏輯（那些已經被 coverage/engagement/timeline 的測試
 * 蓋過了），而是驗證這兩筆新資料本身：內插表確實遞增排序、alt_limits 涵蓋整個
 * envelope 的範圍、PAC-3 的主動雷達導引不需要射手 LOS 而 PAC-2 的 TVM 需要
 * ——這是兩者在地形遮蔽下唯一會畫出不同涵蓋圖的地方，打錯 guidance 欄位
 * 不會讓程式崩潰，只會讓涵蓋圖悄悄變成錯的形狀。
 */

import { describe, it, expect } from 'vitest';
import pac2Json from '../../../data/systems/patriot-pac2.json';
import pac3Json from '../../../data/systems/patriot-pac3.json';
import { kinematicRange } from '../src/envelope.js';
import { computeMvaField, type TerrainSampler } from '../src/mva.js';
import { hasLineOfSight, shooterCheck, type SiteState } from '../src/engagement.js';
import { destination } from '../src/geodesy.js';
import threatsJson from '../../../data/threats.json';
import type { WeaponSystem } from '../src/system.js';
import type { Threat } from '../src/threat.js';

const pac2 = pac2Json as unknown as WeaponSystem;
const pac3 = pac3Json as unknown as WeaponSystem;

const THREATS = (threatsJson as { threats: unknown[] }).threats as unknown as Threat[];
const cruise = THREATS.find((t) => t.id === 'cruise-missile')!;

describe('資料形狀', () => {
  for (const [name, sys] of [
    ['patriot-pac2', pac2],
    ['patriot-pac3', pac3],
  ] as const) {
    it(`${name}：envelope 依 alt_km 嚴格遞增排序（interpolate() 的前提）`, () => {
      const alts = sys.kinematics.envelope.map((p) => p.alt_km);
      for (let i = 1; i < alts.length; i++) expect(alts[i]).toBeGreaterThan(alts[i - 1]);
    });

    it(`${name}：envelope 最高點不超出 alt_limits.max_km`, () => {
      const last = sys.kinematics.envelope[sys.kinematics.envelope.length - 1];
      expect(last.alt_km).toBeLessThanOrEqual(sys.kinematics.alt_limits.max_km);
    });

    it(`${name}：高空射程明顯大於低空射程（不是複製貼上打錯數字）`, () => {
      const low = kinematicRange(sys, 100, 'nominal', 'head_on')!;
      const high = kinematicRange(
        sys,
        sys.kinematics.alt_limits.max_km * 900, // 接近上限的高度 (m)，略打折避免夾在端點外
        'nominal',
        'head_on',
      )!;
      expect(high.rMaxM).toBeGreaterThan(low.rMaxM);
    });
  }
});

describe('PAC-2（TVM）與 PAC-3（主動雷達）的導引差異', () => {
  const ORIGIN = { lon: 120.5, lat: 23.9 };
  /** 東方 8 km 處一道 600 m 的地形牆。 */
  const ridge: TerrainSampler = {
    elevationAt(lon) {
      const dxKm = (lon - ORIGIN.lon) * 111.32 * Math.cos(23.9 * (Math.PI / 180));
      return dxKm > 7.5 && dxKm < 8.5 ? 600 : 0;
    },
  };
  const field = computeMvaField(ORIGIN, ridge, {
    antennaHeightM: 6,
    maxRangeM: 40_000,
    rangeStepM: 100,
    azimuthCount: 360,
  });
  const behindRidge = destination(ORIGIN, 90, 15_000);
  const target = { ...behindRidge, altitudeM: 200 };

  it('山後目標確實不可視', () => {
    expect(hasLineOfSight({ id: 's', ...ORIGIN, groundElevationM: 6, system: pac2, mva: field }, target)).toBe(
      false,
    );
  });

  it('PAC-3 主動雷達導引：山後目標仍可接戰（uplink 打給飛彈，不需射手 LOS）', () => {
    const battery: SiteState = { id: 's', ...ORIGIN, groundElevationM: 6, system: pac3, mva: field };
    expect(shooterCheck(battery, target, { threat: cruise, sensors: [] })).toBeNull();
  });

  it('PAC-2 TVM 導引：山後目標無法接戰（TVM 全程需要地面雷達持續追蹤目標）', () => {
    const battery: SiteState = { id: 's', ...ORIGIN, groundElevationM: 6, system: pac2, mva: field };
    expect(shooterCheck(battery, target, { threat: cruise, sensors: [] })).toBe('guidance-los');
  });
});

describe('彈藥換算', () => {
  it('PAC-3 rounds_per_engagement 未寫成連射數字（hit-to-kill 應為 1）', () => {
    expect(pac3.engagement.rounds_per_engagement?.nominal ?? 1).toBe(1);
  });

  it('PAC-2 與 PAC-3 的 ready_rounds 分別對應 M901（4 枚）與 CRI 發射器（16 枚）', () => {
    expect(pac2.engagement.ready_rounds?.nominal).toBe(4);
    expect(pac3.engagement.ready_rounds?.nominal).toBe(16);
  });
});
