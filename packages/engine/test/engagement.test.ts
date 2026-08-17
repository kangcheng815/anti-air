/**
 * 接戰條件鏈測試。
 *
 * 重點在證明 Phase 3 帶進來的三個新維度真的會改變結果：
 * RCS、感測器—射手分離、導引 LOS。如果換一種威脅、換一種 C2 配置
 * 圖沒有變，那這一層就白做了。
 */

import { describe, it, expect } from 'vitest';
import tk3Json from '../../../data/systems/tk3.json';
import gun35Json from '../../../data/systems/gun35.json';
import sw2Json from '../../../data/systems/sw2-land.json';
import threatsJson from '../../../data/threats.json';

import {
  detectionCheck,
  detectedByAny,
  evaluatePoint,
  shooterCheck,
  hasLineOfSight,
  type SiteState,
} from '../src/engagement.js';
import { detectionRangeM, type Threat } from '../src/threat.js';
import { destination } from '../src/geodesy.js';
import { computeMvaField, type TerrainSampler } from '../src/mva.js';
import type { WeaponSystem } from '../src/system.js';

const tk3 = tk3Json as unknown as WeaponSystem;
const gun35 = gun35Json as unknown as WeaponSystem;
const sw2 = sw2Json as unknown as WeaponSystem;

const THREATS = (threatsJson as { threats: unknown[] }).threats as unknown as Threat[];
const byId = (id: string) => THREATS.find((t) => t.id === id)!;
const cruise = byId('cruise-missile'); // RCS 0.1
const strike = byId('strike-aircraft'); // RCS 5
const stealth = byId('lo-fighter'); // RCS 0.01

const ORIGIN = { lon: 120.6, lat: 24.0 };

function site(system: WeaponSystem, at = ORIGIN, elevM = 0, mva = null): SiteState {
  return { id: system.id, lon: at.lon, lat: at.lat, groundElevationM: elevM, system, mva };
}

/** 由陣地沿方位角推出去的目標點。 */
function targetAt(from: { lon: number; lat: number }, azDeg: number, rangeM: number, altM: number) {
  const p = destination(from, azDeg, rangeM);
  return { lon: p.lon, lat: p.lat, altitudeM: altM };
}

describe('RCS 四次方根律', () => {
  it('RCS 差 50 倍，偵測距離只差 2.66 倍', () => {
    const big = detectionRangeM(250, 1, 5);
    const small = detectionRangeM(250, 1, 0.1);
    expect(big / small).toBeCloseTo(Math.pow(50, 0.25), 3);
  });

  it('參考 RCS 的目標得到參考距離', () => {
    expect(detectionRangeM(250, 1, 1)).toBeCloseTo(250_000, 0);
  });

  it('同一部雷達對巡弋飛彈的偵測距離遠短於對攻擊機', () => {
    const radar = site(tk3);
    const at = (r: number, threat: Threat) =>
      detectionCheck(radar, targetAt(ORIGIN, 90, r, 12_000), threat);

    // r_det_ref 250 km @ RCS 1 → 攻擊機(5) 374 km、巡弋飛彈(0.1) 140 km
    expect(at(200_000, strike)).toBeNull();
    expect(at(200_000, cruise)).toBe('no-detection');
    expect(at(120_000, cruise)).toBeNull();
  });

  it('低可偵測性目標把偵測距離壓到 1/3 以下', () => {
    const radar = site(tk3);
    expect(detectionCheck(radar, targetAt(ORIGIN, 90, 100_000, 12_000), stealth)).toBe(
      'no-detection',
    );
    expect(detectionCheck(radar, targetAt(ORIGIN, 90, 70_000, 12_000), stealth)).toBeNull();
  });
});

describe('感測器仰角限制造成的頭頂靜默錐', () => {
  const radar = site(tk3); // elevation_limits_deg: [-2, 70]

  it('正上方高空目標偵測不到', () => {
    const overhead = { lon: ORIGIN.lon, lat: ORIGIN.lat + 0.005, altitudeM: 20_000 };
    expect(detectionCheck(radar, overhead, strike)).toBe('sector');
  });

  it('同高度但拉開水平距離後就進入掃描範圍', () => {
    expect(detectionCheck(radar, targetAt(ORIGIN, 90, 40_000, 20_000), strike)).toBeNull();
  });
});

describe('導引 LOS：主動 vs 需照射', () => {
  /** 東邊 8 km 處一道 800 m 的牆。 */
  const ridge: TerrainSampler = {
    elevationAt(lon) {
      const dxKm = (lon - ORIGIN.lon) * 111.32 * Math.cos(24 * (Math.PI / 180));
      return dxKm > 7.5 && dxKm < 8.5 ? 800 : 0;
    },
  };
  const field = computeMvaField(ORIGIN, ridge, {
    antennaHeightM: 8,
    maxRangeM: 40_000,
    rangeStepM: 100,
    azimuthCount: 360,
  });

  const behindRidge = targetAt(ORIGIN, 90, 20_000, 300);

  it('山後 300 m 的目標確實看不見', () => {
    expect(hasLineOfSight({ ...site(tk3), mva: field }, behindRidge)).toBe(false);
  });

  it('主動導引（天弓三型）在看不見的情況下仍可接戰', () => {
    const battery: SiteState = { ...site(tk3), mva: field };
    expect(shooterCheck(battery, behindRidge, { threat: cruise, sensors: [] })).toBeNull();
  });

  it('需照射的系統（35 快砲）被地形擋住就不能接戰', () => {
    const near = targetAt(ORIGIN, 90, 3000, 300);
    const gunField = computeMvaField(ORIGIN, ridge, {
      antennaHeightM: 3,
      maxRangeM: 10_000,
      rangeStepM: 50,
      azimuthCount: 360,
    });
    const battery: SiteState = { ...site(gun35), mva: gunField };
    // 3 km 處未被 8 km 的牆擋住，可接戰
    expect(shooterCheck(battery, near, { threat: cruise, sensors: [] })).toBeNull();

    // 把牆挪到 2 km 處，同一個目標就被擋掉
    const closeRidge: TerrainSampler = {
      elevationAt(lon) {
        const dxKm = (lon - ORIGIN.lon) * 111.32 * Math.cos(24 * (Math.PI / 180));
        return dxKm > 1.8 && dxKm < 2.2 ? 800 : 0;
      },
    };
    const blocked: SiteState = {
      ...site(gun35),
      mva: computeMvaField(ORIGIN, closeRidge, {
        antennaHeightM: 3,
        maxRangeM: 10_000,
        rangeStepM: 50,
        azimuthCount: 360,
      }),
    };
    expect(shooterCheck(blocked, near, { threat: cruise, sensors: [] })).toBe('guidance-los');
  });
});

describe('感測器—射手分離', () => {
  /**
   * 這一組刻意選了「運動學射程遠大於自身雷達偵測距離」的配置 ——
   * 天弓三型對 RCS 0.01 的目標只能看到 79 km（250·0.01^0.25），
   * 但飛彈在 10 km 高度打得到 185 km。中間這段 100 km 就是
   * 感測器—射手分離存在的理由：沒有外部供軌，飛彈的射程是浪費的。
   */
  const shooter: SiteState = { ...site(tk3, ORIGIN), id: 'shooter' };
  const fwdPos = destination(ORIGIN, 90, 100_000);
  const forwardRadar: SiteState = {
    ...site(tk3, { lon: fwdPos.lon, lat: fwdPos.lat }),
    id: 'forward',
  };

  const target = targetAt(ORIGIN, 90, 150_000, 10_000);

  it('目標在射手的運動學射程內（不是射程問題）', () => {
    expect(shooterCheck(shooter, target, { threat: stealth, sensors: [] })).toBeNull();
  });

  it('各自為政時，射手自己的雷達對此目標偵測不到', () => {
    expect(detectedByAny([shooter], target, stealth)).toBe(false);
    const v = evaluatePoint(target, [shooter], { threat: stealth, sensors: [shooter] });
    expect(v.detected).toBe(false);
    expect(v.engagedBy).toHaveLength(0);
  });

  it('納入前推雷達的 C2 群組後，同一個射手就能接戰', () => {
    const v = evaluatePoint(target, [shooter], {
      threat: stealth,
      sensors: [shooter, forwardRadar],
    });
    expect(v.detected).toBe(true);
    expect(v.engagedBy).toEqual(['shooter']);
  });

  it('對大 RCS 目標，射手自己的雷達就夠了（差異只在小目標時才顯現）', () => {
    expect(detectedByAny([shooter], target, strike)).toBe(true);
  });
});

describe('evaluatePoint 的縱深計算', () => {
  const a = { ...site(tk3, ORIGIN), id: 'a' };
  const bPos = destination(ORIGIN, 0, 20_000);
  const b = { ...site(tk3, { lon: bPos.lon, lat: bPos.lat }), id: 'b' };
  const sensors = [a, b];

  it('兩套系統都涵蓋的點縱深為 2', () => {
    const mid = targetAt(ORIGIN, 0, 10_000, 8000);
    expect(evaluatePoint(mid, [a, b], { threat: strike, sensors }).engagedBy).toHaveLength(2);
  });

  it('未被偵獲的點縱深必為 0，即使運動學打得到', () => {
    const far = targetAt(ORIGIN, 90, 160_000, 12_000);
    const v = evaluatePoint(far, [a, b], { threat: stealth, sensors });
    expect(v.detected).toBe(false);
    expect(v.engagedBy).toHaveLength(0);
    // 但運動學本身是夠的 —— 證明擋住它的是偵測而不是射程
    expect(shooterCheck(a, far, { threat: stealth, sensors })).toBeNull();
  });

  it('目標型別不符的系統不參與（35 快砲打不到彈道飛彈）', () => {
    const tbm = byId('tbm');
    const high = targetAt(ORIGIN, 0, 5000, 40_000);
    expect(shooterCheck(site(gun35), high, { threat: tbm, sensors: [] })).toBe('target-class');
  });
});
