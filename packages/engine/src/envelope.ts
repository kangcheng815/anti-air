/**
 * 運動學包絡內插。
 *
 * 把 data/systems/*.json 的 range_at_alt 插值表，變成「這個高度打得到多遠」。
 * 純運動學，不含任何可視性判斷 —— 那是 coverage.ts 的事。
 * 兩者分開，是因為原始構想把「飛得到」和「看得到」混成同一個數字，
 * 而這兩件事在台灣地形下經常差很遠。
 */

import { resolve, type EstimateMode } from './estimate.js';
import type { Aspect, WeaponSystem } from './system.js';

export interface KinematicRange {
  /** 運動學最大射程 (m)。 */
  rMaxM: number;
  /** 運動學最小射程 (m)。無資料時為 0。 */
  rMinM: number;
}

/**
 * 在已排序的 (x, y) 序列上線性內插。
 * **兩端夾住，絕不外插** —— 外插的射程數字是憑空捏造的，寧可保守。
 */
function interpolate(points: readonly { x: number; y: number }[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}

/**
 * 指定高度下的運動學射程。高度超出 alt_limits 時回傳 null（完全打不到）。
 *
 * @param altitudeM 目標高度 (m, 海平面基準)
 */
export function kinematicRange(
  system: WeaponSystem,
  altitudeM: number,
  mode: EstimateMode = 'nominal',
  aspect: Aspect = 'head_on',
): KinematicRange | null {
  const { envelope, alt_limits, aspect_factor } = system.kinematics;
  const altKm = altitudeM / 1000;

  if (altKm < alt_limits.min_km || altKm > alt_limits.max_km) return null;

  const maxPoints = envelope.map((p) => ({
    x: p.alt_km,
    y: resolve(p.r_max, mode, 'higher') * 1000,
  }));

  // r_min 是選填的：只在有給值的高度點上內插，全都沒給就當 0。
  const minPoints = envelope
    .filter((p) => p.r_min !== undefined)
    .map((p) => ({ x: p.alt_km, y: resolve(p.r_min!, mode, 'lower') * 1000 }));

  const factor = aspect_factor?.[aspect] ?? (aspect === 'head_on' ? 1 : 1);

  return {
    rMaxM: interpolate(maxPoints, altKm) * factor,
    rMinM: minPoints.length > 0 ? interpolate(minPoints, altKm) : 0,
  };
}

/** 該系統在整個高度範圍內能打到的最遠距離 (m)，用來抓地圖預設縮放。 */
export function peakRangeM(system: WeaponSystem, mode: EstimateMode = 'nominal'): number {
  return Math.max(
    ...system.kinematics.envelope.map((p) => resolve(p.r_max, mode, 'higher') * 1000),
  );
}
