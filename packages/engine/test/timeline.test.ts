/**
 * 接戰時間軸測試。
 *
 * 要證明的事分三類：
 *   1. 攔截解本身是對的（飛彈飛行距離 = 速度 × 飛行時間，且攔截點在航跡上）。
 *   2. 每一個資源限制真的會咬人：通道、待發彈、反應時間。
 *   3. 不同的漏網原因確實被區分開 —— 「沒偵獲」與「通道滿了」在防空規劃上
 *      是完全不同的問題，混成一句「沒打到」等於什麼都沒說。
 */

import { describe, it, expect } from 'vitest';
import tk3Json from '../../../data/systems/tk3.json';
import sw2Json from '../../../data/systems/sw2-land.json';
import gun35Json from '../../../data/systems/gun35.json';
import threatsJson from '../../../data/threats.json';

import { simulate, type TimelineTrack } from '../src/timeline.js';
import { trackGeometry } from '../src/track.js';
import { bearingDistance, destination } from '../src/geodesy.js';
import type { SiteState } from '../src/engagement.js';
import type { WeaponSystem } from '../src/system.js';
import type { Threat } from '../src/threat.js';

const tk3 = tk3Json as unknown as WeaponSystem;
const sw2 = sw2Json as unknown as WeaponSystem;
const gun35 = gun35Json as unknown as WeaponSystem;

const THREATS = (threatsJson as { threats: unknown[] }).threats as unknown as Threat[];
const byId = (id: string) => THREATS.find((t) => t.id === id)!;
const cruise = byId('cruise-missile'); // RCS 0.1、250 m/s
const strike = byId('strike-aircraft'); // RCS 5、280 m/s

const BASE = { lon: 120.3, lat: 23.5 };

function battery(system: WeaponSystem, id: string, at = BASE, elevM = 20): SiteState {
  return { id, lon: at.lon, lat: at.lat, groundElevationM: elevM, system, mva: null };
}

/**
 * 從陣地正東 rangeM 處直線西飛、正對陣地的航跡。
 * 終點就是陣地本身 —— 目標區即防禦資產，「抵達」代表防空失敗。
 */
function inbound(
  id: string,
  threat: Threat,
  rangeM: number,
  altM: number,
  speedMps: number,
  extra: Partial<TimelineTrack> = {},
): TimelineTrack {
  const start = destination(BASE, 90, rangeM);
  return {
    id,
    threat,
    waypoints: [
      { lon: start.lon, lat: start.lat, altitudeM: altM },
      { ...BASE, altitudeM: altM },
    ],
    speedMps,
    count: 1,
    spacingS: 0,
    startTimeS: 0,
    ...extra,
  };
}

const allSensors = (sites: SiteState[]) => () => sites.filter((s) => s.system.sensor);

describe('攔截解', () => {
  const b = battery(tk3, 'tk3-1');
  const track = inbound('t', strike, 220_000, 8000, 280);
  const res = simulate({
    batteries: [b],
    sensorsOf: allSensors([b]),
    tracks: [track],
  });

  it('產生了射擊機會', () => {
    expect(res.summary.totalShots).toBeGreaterThan(0);
  });

  it('飛彈飛行距離 = 平均速度 × 飛行時間', () => {
    for (const s of res.shots) {
      const tof = s.interceptTimeS - s.fireTimeS;
      expect(s.interceptRangeM).toBeCloseTo(1200 * tof, 3);
    }
  });

  it('攔截點確實落在航跡上，且射手到該點的距離等於飛彈飛行距離', () => {
    const geom = trackGeometry(track);
    for (const s of res.shots) {
      const d = bearingDistance(
        { lon: s.interceptLon, lat: s.interceptLat },
        { lon: track.waypoints[1].lon, lat: track.waypoints[1].lat },
      ).distanceM;
      expect(d).toBeLessThanOrEqual(geom.totalM + 1);

      const flight = bearingDistance(b, { lon: s.interceptLon, lat: s.interceptLat }).distanceM;
      // 二分收斂容差；相對於 100 km 級的距離可忽略
      expect(Math.abs(flight - s.interceptRangeM)).toBeLessThan(50);
    }
  });

  it('迎面而來的目標，攔截距離短於發射距離', () => {
    for (const s of res.shots) {
      expect(s.interceptRangeM).toBeLessThan(s.fireRangeM);
    }
  });

  it('攔截一定發生在目標抵達目標區之前', () => {
    const arrival = res.contacts[0].arrivalTimeS;
    for (const s of res.shots) expect(s.interceptTimeS).toBeLessThanOrEqual(arrival);
  });

  it('第一發在偵獲 + 反應時間之後', () => {
    const first = res.shots.reduce((a, s) => (s.fireTimeS < a.fireTimeS ? s : a));
    expect(first.fireTimeS).toBeGreaterThanOrEqual(res.contacts[0].firstDetectS! + 10);
  });
});

describe('資源限制：通道', () => {
  /**
   * 陸射劍二 4 個通道，對上同時進入的 12 個接觸。
   * 交戰時間（飛行 + 評估）明顯長於通道數能吃下的量，必然有人漏網。
   */
  const b = battery(sw2, 'sw2-1');
  const raid = inbound('raid', cruise, 18_000, 100, 250, { count: 12, spacingS: 0 });

  const res = simulate({
    batteries: [b],
    sensorsOf: allSensors([b]),
    tracks: [raid],
  });

  it('展開成 12 個接觸', () => {
    expect(res.summary.contactCount).toBe(12);
  });

  it('尖峰同時佔用通道數不超過規格', () => {
    expect(res.loads[0].peakChannelsUsed).toBeLessThanOrEqual(4);
  });

  it('有目標因通道全滿而漏網，且原因被正確標成飽和', () => {
    const saturated = res.contacts.filter((c) => c.leakReason === 'channels-saturated');
    expect(saturated.length).toBeGreaterThan(0);
    expect(res.loads[0].deniedByChannel).toBeGreaterThan(0);
  });

  it('把通道加到 12 之後，漏網數下降', () => {
    const wide: WeaponSystem = {
      ...sw2,
      engagement: { ...sw2.engagement, channels: { nominal: 12, confidence: 'low' } },
    };
    const wb = battery(wide, 'sw2-wide');
    const res2 = simulate({
      batteries: [wb],
      sensorsOf: allSensors([wb]),
      tracks: [raid],
    });
    expect(res2.summary.leakCount).toBeLessThan(res.summary.leakCount);
  });
});

describe('資源限制：待發彈', () => {
  const thin: WeaponSystem = {
    ...tk3,
    engagement: { ...tk3.engagement, ready_rounds: { nominal: 2, confidence: 'low' } },
  };
  const b = battery(thin, 'tk3-thin');
  const raid = inbound('raid', strike, 150_000, 8000, 280, { count: 8, spacingS: 20 });

  const res = simulate({
    batteries: [b],
    sensorsOf: allSensors([b]),
    tracks: [raid],
  });

  it('發射彈數不超過待發彈量', () => {
    expect(res.loads[0].roundsFired).toBeLessThanOrEqual(2);
  });

  it('後續目標因彈藥耗盡而漏網', () => {
    expect(res.contacts.some((c) => c.leakReason === 'magazine-empty')).toBe(true);
    expect(res.loads[0].deniedByMagazine).toBeGreaterThan(0);
  });

  it('陣地層級的待發彈覆寫系統目錄值', () => {
    // 系統目錄的 ready_rounds 是單一發射單元的量；一個連有幾具發射架
    // 是編制問題，只能在陣地層級給。不支援覆寫的話，天弓三型陣地
    // 永遠只有 4 發，任何波次分析都會退化成「打四發就沒了」。
    const b8: SiteState = { ...b, readyRoundsOverride: 8 };
    const res8 = simulate({
      batteries: [b8],
      sensorsOf: allSensors([b8]),
      tracks: [raid],
    });
    expect(res8.loads[0].readyRounds).toBe(8);
    expect(res8.loads[0].roundsFired).toBeGreaterThan(2);
    expect(res8.loads[0].roundsFired).toBeLessThanOrEqual(8);
    expect(res8.summary.totalShots).toBeGreaterThan(res.summary.totalShots);
  });

  it('齊射兩發時，同樣的彈量只夠一次接戰', () => {
    const res2 = simulate({
      batteries: [b],
      sensorsOf: allSensors([b]),
      tracks: [raid],
      salvoSize: 2,
    });
    expect(res2.summary.totalShots).toBe(1);
    expect(res2.loads[0].roundsFired).toBe(2);
  });
});

describe('火砲的彈數換算', () => {
  /**
   * 35 快砲的 ready_rounds 是 238「發」，不是 238 次接戰機會。
   * rounds_per_engagement = 30 讓它變成約 8 次 —— 這個換算若漏掉，
   * 快砲在飽和分析裡會變成幾乎無限的彈藥。
   */
  const b = battery(gun35, 'gun-1');
  const raid = inbound('raid', cruise, 4000, 80, 250, { count: 20, spacingS: 12 });

  const res = simulate({
    batteries: [b],
    sensorsOf: allSensors([b]),
    tracks: [raid],
    maxEngagementsPerContact: 1,
  });

  it('每次接戰消耗 30 發', () => {
    for (const s of res.shots) expect(s.rounds).toBe(30);
  });

  it('接戰次數被 238 發限制在 8 次以內', () => {
    expect(res.summary.totalShots).toBeLessThanOrEqual(7); // floor(238/30) = 7
    expect(res.loads[0].roundsFired).toBeLessThanOrEqual(238);
  });
});

describe('漏網原因的區分', () => {
  it('完全在偵測距離外的航跡 —— 從未偵獲', () => {
    // 陸射劍二對 RCS 0.1 只看得到 60·0.1^0.25 ≈ 33.7 km；
    // 航跡整條放在 80 km 外，且不朝陣地飛。
    const far = destination(BASE, 90, 80_000);
    const far2 = destination(far, 0, 60_000);
    const b = battery(sw2, 'sw2-1');
    const res = simulate({
      batteries: [b],
      sensorsOf: allSensors([b]),
      tracks: [
        {
          id: 'far',
          threat: cruise,
          waypoints: [
            { lon: far.lon, lat: far.lat, altitudeM: 3000 },
            { lon: far2.lon, lat: far2.lat, altitudeM: 3000 },
          ],
          speedMps: 250,
          count: 1,
          spacingS: 0,
          startTimeS: 0,
        },
      ],
    });
    expect(res.contacts[0].firstDetectS).toBeNull();
    expect(res.contacts[0].leakReason).toBe('never-detected');
  });

  it('偵獲得到但運動學搆不到 —— 不在包絡內', () => {
    // 天弓三型偵測 250·5^0.25 ≈ 374 km，但 20 km 高度的運動學上限 200 km。
    // 航跡整條放在 300 km 外橫飛。
    const p1 = destination(BASE, 90, 300_000);
    const p2 = destination(p1, 0, 80_000);
    const b = battery(tk3, 'tk3-1');
    const res = simulate({
      batteries: [b],
      sensorsOf: allSensors([b]),
      tracks: [
        {
          id: 'cross',
          threat: strike,
          waypoints: [
            { lon: p1.lon, lat: p1.lat, altitudeM: 12_000 },
            { lon: p2.lon, lat: p2.lat, altitudeM: 12_000 },
          ],
          speedMps: 280,
          count: 1,
          spacingS: 0,
          startTimeS: 0,
        },
      ],
    });
    expect(res.contacts[0].firstDetectS).not.toBeNull();
    expect(res.contacts[0].leakReason).toBe('never-in-envelope');
  });

  it('偵獲到抵達之間短於反應時間 —— 來不及', () => {
    // 只有 2 km 的航跡，250 m/s 走完只要 8 秒，短於陸射劍二的 6 s 反應
    // 加上飛行時間；把反應時間拉到 30 s 讓條件明確。
    const slowSys: WeaponSystem = {
      ...sw2,
      engagement: { ...sw2.engagement, reaction_s: { nominal: 30, confidence: 'low' } },
    };
    const b = battery(slowSys, 'sw2-slow');
    const start = destination(BASE, 90, 6000);
    const res = simulate({
      batteries: [b],
      sensorsOf: allSensors([b]),
      tracks: [
        {
          id: 'popup',
          threat: cruise,
          waypoints: [
            { lon: start.lon, lat: start.lat, altitudeM: 200 },
            { ...BASE, altitudeM: 200 },
          ],
          speedMps: 250,
          count: 1,
          spacingS: 0,
          startTimeS: 0,
        },
      ],
    });
    expect(res.contacts[0].firstDetectS).not.toBeNull();
    expect(res.contacts[0].shots).toHaveLength(0);
    expect(res.contacts[0].leakReason).toBe('too-late');
  });
});

describe('估計模式的影響', () => {
  const b = battery(tk3, 'tk3-1');
  const track = inbound('t', strike, 200_000, 8000, 280, { count: 6, spacingS: 25 });

  const nominal = simulate({ batteries: [b], sensorsOf: allSensors([b]), tracks: [track] });
  const conservative = simulate({
    batteries: [b],
    sensorsOf: allSensors([b]),
    tracks: [track],
    mode: 'conservative',
  });

  it('保守模式的射擊機會不會多於標稱', () => {
    expect(conservative.summary.totalShots).toBeLessThanOrEqual(nominal.summary.totalShots);
  });

  it('保守模式取較長的反應時間與較短的射程，第一發較晚', () => {
    const firstOf = (r: typeof nominal) =>
      r.shots.length > 0 ? Math.min(...r.shots.map((s) => s.fireTimeS)) : Infinity;
    expect(firstOf(conservative)).toBeGreaterThanOrEqual(firstOf(nominal));
  });
});

describe('多層防空的疊加', () => {
  /** 天弓三型在後、陸射劍二在前 15 km，同一條進襲航線。 */
  const fwd = destination(BASE, 90, 15_000);
  const high = battery(tk3, 'tk3-1');
  const short = battery(sw2, 'sw2-1', { lon: fwd.lon, lat: fwd.lat });
  const sites = [high, short];
  const track = inbound('t', strike, 180_000, 6000, 280);

  const res = simulate({
    batteries: sites,
    sensorsOf: allSensors(sites),
    tracks: [track],
  });

  it('兩套系統都取得射擊機會', () => {
    const ids = new Set(res.shots.map((s) => s.siteId));
    expect(ids.has('tk3-1')).toBe(true);
    expect(ids.has('sw2-1')).toBe(true);
  });

  it('高層先打、點防空後打', () => {
    const firstBy = (id: string) =>
      Math.min(...res.shots.filter((s) => s.siteId === id).map((s) => s.fireTimeS));
    expect(firstBy('tk3-1')).toBeLessThan(firstBy('sw2-1'));
  });

  it('每個射手對同一目標的接戰次數受上限約束', () => {
    for (const id of ['tk3-1', 'sw2-1']) {
      expect(res.shots.filter((s) => s.siteId === id).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('缺少必要參數時據實回報', () => {
  it('沒有平均飛彈速度的系統被排除並列名，而不是靜默忽略', () => {
    const noSpeed: WeaponSystem = {
      ...tk3,
      engagement: { ...tk3.engagement, avg_missile_speed_mps: undefined },
    };
    const b = battery(noSpeed, 'broken');
    const res = simulate({
      batteries: [b],
      sensorsOf: allSensors([b]),
      tracks: [inbound('t', strike, 150_000, 8000, 280)],
    });
    expect(res.skipped).toEqual([{ siteId: 'broken', reason: 'no-missile-speed' }]);
    expect(res.summary.totalShots).toBe(0);
  });
});
