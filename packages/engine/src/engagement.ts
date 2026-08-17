/**
 * 接戰判定：DESIGN.md §4 的完整條件鏈。
 *
 * 這是 Phase 3 的核心。Phase 1–2 的 computeCoverage 回答「這個圈多大」，
 * 本檔回答「這一個點，對這一種威脅，這一套系統打不打得到，打不到是卡在哪一關」。
 *
 * 三個 Phase 1–2 沒有的維度：
 *   1. **感測器—射手分離**：偵獲由 C2 群組內任一感測器達成，不必是射手自己。
 *   2. **RCS 相依**：偵測距離 ∝ RCS^(1/4)，小目標把每個感測器的圈都縮小。
 *   3. **導引 LOS**：需照射的系統（SARH／光學砲瞄）必須自己看得見目標；
 *      主動導引的不必。同一片地形下，兩者的可接戰區形狀完全不同。
 */

import { antennaHeightAglM } from './coverage.js';
import { kinematicRange } from './envelope.js';
import { bearingDistance, type LonLat } from './geodesy.js';
import { resolve, type EstimateMode } from './estimate.js';
import {
  curvatureDrop,
  extrapolatedMvaAt,
  radarHorizonRangeM,
  DEFAULT_K_FACTOR,
  type MvaField,
} from './mva.js';
import { detectionRangeM, type Threat } from './threat.js';
import type { Aspect, WeaponSystem } from './system.js';

/** 判定所需的陣地狀態。感測器與射手用同一個型別 —— 差別只在有沒有 sensor 規格。 */
export interface SiteState {
  id: string;
  lon: number;
  lat: number;
  /** 地面高程 (m, 海平面基準)。 */
  groundElevationM: number;
  system: WeaponSystem;
  /** Phase 2 的地形場。null 代表退回平坦地形地平線。 */
  mva: MvaField | null;
  /**
   * 本陣地的待發彈量，覆寫系統目錄的 `ready_rounds`。
   *
   * 這個欄位必須存在，因為 `ready_rounds` 描述的是**單一發射單元**
   * （tk3.json 的註解就明講了「每發射箱；一個連的總數需在陣地層級設定」）。
   * 一個連有幾具發射架是編制問題，不是武器性能，不該寫進系統目錄。
   * 省略時退回系統值。
   */
  readyRoundsOverride?: number;
}

export interface TargetPoint extends LonLat {
  /** 海平面基準高度 (m)。 */
  altitudeM: number;
}

export type BlockReason =
  | 'target-class'
  | 'altitude-limit'
  | 'out-of-range'
  | 'min-range'
  | 'sector'
  | 'no-detection'
  | 'guidance-los';

export interface EngageOptions {
  threat: Threat;
  /** C2 群組內可供軌的感測器。只放自己 = 各自為政。 */
  sensors: SiteState[];
  mode?: EstimateMode;
  aspect?: Aspect;
  kFactor?: number;
}

// ---------------------------------------------------------------- 可視性

/**
 * 從陣地到目標點是否有視線。
 *
 * MVA 場涵蓋範圍內以場為準（已含地形 + 曲率 + 折射）；
 * 超出場的範圍退回平坦地形地平線 —— 那不是「被遮蔽」，是「沒有地形資料」。
 */
export function hasLineOfSight(
  site: SiteState,
  target: TargetPoint,
  kFactor = DEFAULT_K_FACTOR,
): boolean {
  const { azimuthDeg, distanceM } = bearingDistance(site, target);
  if (distanceM === 0) return true;

  if (site.mva) {
    // 超出場的計算半徑時外推邊界射線，而不是退回平坦地形 ——
    // 後者會讓山背後的遠距低空目標被誤判為可見。
    return target.altitudeM >= extrapolatedMvaAt(site.mva, azimuthDeg, distanceM);
  }

  const antennaAbsM = site.groundElevationM + antennaHeightAglM(site.system);
  return distanceM <= radarHorizonRangeM(antennaAbsM, Math.max(0, target.altitudeM), kFactor);
}

/** 目標相對感測器的視仰角（度）。含曲率下沉，所以遠距低空目標會落到負值。 */
function elevationAngleDeg(
  distanceM: number,
  targetAltM: number,
  sensorAbsM: number,
  kFactor: number,
): number {
  if (distanceM <= 0) return targetAltM >= sensorAbsM ? 90 : -90;
  const dh = targetAltM - curvatureDrop(distanceM, kFactor) - sensorAbsM;
  return (Math.atan2(dh, distanceM) * 180) / Math.PI;
}

function azimuthInMask(azimuthDeg: number, mask?: number[][]): boolean {
  if (!mask || mask.length === 0) return true;
  const a = ((azimuthDeg % 360) + 360) % 360;
  return mask.some(([from, to]) => {
    const f = ((from % 360) + 360) % 360;
    const t = ((to % 360) + 360) % 360;
    return f <= t ? a >= f && a <= t : a >= f || a <= t;
  });
}

// ---------------------------------------------------------------- 偵獲

/**
 * 單一感測器能否偵獲目標。回傳 null 代表能，否則給出卡在哪一關。
 *
 * 注意仰角上界：多數 3D 雷達掃不到頭頂，形成「靜默錐」。
 * 這在地圖上是陣地正上方一個真實的空洞，不是繪圖瑕疵。
 */
export function detectionCheck(
  sensor: SiteState,
  target: TargetPoint,
  threat: Threat,
  mode: EstimateMode = 'nominal',
  kFactor = DEFAULT_K_FACTOR,
): BlockReason | null {
  const spec = sensor.system.sensor;
  if (!spec) return 'no-detection';

  const { azimuthDeg, distanceM } = bearingDistance(sensor, target);

  const rcs = resolve(threat.rcs_m2, mode, 'lower');
  const rDet = detectionRangeM(
    resolve(spec.r_det_ref_km, mode, 'higher'),
    spec.rcs_ref_m2 ?? 1,
    rcs,
  );
  if (distanceM > rDet) return 'no-detection';

  if (!azimuthInMask(azimuthDeg, spec.azimuth_mask_deg)) return 'sector';

  if (spec.elevation_limits_deg) {
    const sensorAbsM = sensor.groundElevationM + spec.antenna_height_m.nominal;
    const elev = elevationAngleDeg(distanceM, target.altitudeM, sensorAbsM, kFactor);
    const [lo, hi] = spec.elevation_limits_deg;
    if (elev < lo || elev > hi) return 'sector';
  }

  if (!hasLineOfSight(sensor, target, kFactor)) return 'no-detection';

  return null;
}

/** C2 群組內是否有任一感測器偵獲。 */
export function detectedByAny(
  sensors: SiteState[],
  target: TargetPoint,
  threat: Threat,
  mode: EstimateMode = 'nominal',
  kFactor = DEFAULT_K_FACTOR,
): boolean {
  for (const s of sensors) {
    if (detectionCheck(s, target, threat, mode, kFactor) === null) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 射手

/**
 * 射手端的判定（不含偵獲）。偵獲另外算，因為它與射手無關、
 * 在逐點掃描時可以只算一次而不是每個射手重算一遍。
 */
export function shooterCheck(
  battery: SiteState,
  target: TargetPoint,
  opts: EngageOptions,
): BlockReason | null {
  const { threat } = opts;
  const mode = opts.mode ?? 'nominal';
  const aspect = opts.aspect ?? 'head_on';
  const kFactor = opts.kFactor ?? DEFAULT_K_FACTOR;
  const system = battery.system;

  if (system.targets && !system.targets.includes(threat.class)) return 'target-class';

  const kin = kinematicRange(system, target.altitudeM, mode, aspect);
  if (!kin) return 'altitude-limit';

  const { azimuthDeg, distanceM } = bearingDistance(battery, target);
  if (distanceM > kin.rMaxM) return 'out-of-range';
  if (distanceM < kin.rMinM) return 'min-range';

  if (system.sensor && !azimuthInMask(azimuthDeg, system.sensor.azimuth_mask_deg)) {
    return 'sector';
  }

  // 導引視線。
  //
  // 只有需要全程照射的系統（SARH／CLOS／光學砲瞄）要求射手自己看得見目標。
  // uplink_required 不在此列：中途指令是打給**飛彈**的，飛彈飛在高空，
  // 發射架不需要看到目標。把兩者混為一談會讓主動導引與半主動導引在圖上
  // 長得一模一樣，而那正是這一層最想呈現的差異。
  if (system.guidance.requires_illumination && !hasLineOfSight(battery, target, kFactor)) {
    return 'guidance-los';
  }

  return null;
}

// ---------------------------------------------------------------- 組合

export interface PointVerdict {
  /** 能接戰的陣地 id。長度即該點的防空縱深。 */
  engagedBy: string[];
  /** C2 群組是否偵獲此點。false 時縱深必為 0。 */
  detected: boolean;
}

/**
 * 單點的完整判定。
 *
 * 先算偵獲（O(感測器數)），再逐射手算運動學與導引（O(射手數)），
 * 而不是每個射手都重跑一次全部感測器。縱深熱圖要對數萬個點做這件事，
 * 這個拆法是它能在瀏覽器裡即時跑完的原因。
 */
export function evaluatePoint(
  target: TargetPoint,
  batteries: SiteState[],
  opts: EngageOptions,
): PointVerdict {
  const mode = opts.mode ?? 'nominal';
  const kFactor = opts.kFactor ?? DEFAULT_K_FACTOR;

  const detected = detectedByAny(opts.sensors, target, opts.threat, mode, kFactor);
  if (!detected) return { engagedBy: [], detected: false };

  const engagedBy: string[] = [];
  for (const b of batteries) {
    if (shooterCheck(b, target, opts) === null) engagedBy.push(b.id);
  }
  return { engagedBy, detected: true };
}

/** 該點的防空縱深：有幾套系統能接戰。 */
export function depthAt(
  target: TargetPoint,
  batteries: SiteState[],
  opts: EngageOptions,
): number {
  return evaluatePoint(target, batteries, opts).engagedBy.length;
}
