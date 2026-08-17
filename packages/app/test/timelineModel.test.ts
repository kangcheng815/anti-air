/**
 * store 的航跡 → 引擎航跡的轉換。
 *
 * 重點是高度內插必須依**沿線累積距離**，不是航點序號。
 * 一條 200 km 的長段接一條 10 km 的短段時，用序號會讓高度在短段上暴跌 ——
 * 而那個錯誤在地圖上完全看不出來，只會讓時間軸的接戰結果悄悄變成錯的。
 */

import { describe, it, expect } from 'vitest';
import { trackGeometry } from '@anti-air/engine';
import { toEngineTrack } from '../src/analysis/timelineModel';
import type { ThreatTrack } from '../src/state/store';

function track(over: Partial<ThreatTrack> = {}): ThreatTrack {
  return {
    id: 'tr1',
    name: '測試航跡',
    threatId: 'cruise-missile',
    path: [
      [119.1, 24.26],
      [120.58, 24.26],
    ],
    speedMps: 250,
    altStartM: 100,
    altEndM: 100,
    count: 1,
    spacingS: 0,
    startTimeS: 0,
    ...over,
  };
}

describe('航跡轉換', () => {
  it('威脅 id 解析成完整的威脅剖面', () => {
    const t = toEngineTrack(track())!;
    expect(t.threat.id).toBe('cruise-missile');
    expect(t.threat.rcs_m2.nominal).toBe(0.1);
  });

  it('少於兩個航點時回傳 null，而不是一條長度 0 的航跡', () => {
    expect(toEngineTrack(track({ path: [[120, 24]] }))).toBeNull();
    expect(toEngineTrack(track({ path: [] }))).toBeNull();
  });

  it('未知威脅 id 回傳 null', () => {
    expect(toEngineTrack(track({ threatId: 'does-not-exist' }))).toBeNull();
  });

  it('等高度航跡的每個航點高度相同', () => {
    const t = toEngineTrack(track({ altStartM: 300, altEndM: 300 }))!;
    for (const wp of t.waypoints) expect(wp.altitudeM).toBe(300);
  });

  it('下降剖面：兩端等於設定值', () => {
    const t = toEngineTrack(track({ altStartM: 8000, altEndM: 100 }))!;
    expect(t.waypoints[0].altitudeM).toBeCloseTo(8000, 3);
    expect(t.waypoints[t.waypoints.length - 1].altitudeM).toBeCloseTo(100, 3);
  });

  it('中間航點依累積距離內插，不是依序號', () => {
    // 長段 150 km + 短段 15 km。轉折點在全程的 91%，
    // 若誤用序號比例會算成 50%。
    const t = toEngineTrack(
      track({
        path: [
          [119.1, 24.26],
          [120.58, 24.26],
          [120.73, 24.26],
        ],
        altStartM: 10_000,
        altEndM: 0,
      }),
    )!;
    const geom = trackGeometry(t);
    const frac = geom.cumM[1] / geom.totalM;
    expect(frac).toBeGreaterThan(0.88);
    expect(t.waypoints[1].altitudeM).toBeCloseTo(10_000 * (1 - frac), 0);
    // 若用序號比例會是 5000 —— 明確排除
    expect(t.waypoints[1].altitudeM).toBeLessThan(2000);
  });

  it('波次參數被夾在合法範圍內', () => {
    const t = toEngineTrack(track({ count: 0, spacingS: -5, startTimeS: -10 }))!;
    expect(t.count).toBe(1);
    expect(t.spacingS).toBe(0);
    expect(t.startTimeS).toBe(0);
  });
});
