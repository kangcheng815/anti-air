/**
 * 涵蓋計算的單一入口。
 *
 * 回傳的是**逐方位角的半徑陣列**，即使 Phase 1 每個方位都一樣。
 * 這是刻意的：Phase 2 接上 MVA 場之後半徑會變成鋸齒狀，屆時只有本檔要改，
 * 呼叫端（地圖圖層、剖面圖、統計）一行都不用動。
 */

import { kinematicRange } from './envelope.js';
import {
  extrapolatedMvaAt,
  radarHorizonRangeM,
  DEFAULT_K_FACTOR,
  type MvaField,
} from './mva.js';
import type { EstimateMode } from './estimate.js';
import type { Aspect, WeaponSystem } from './system.js';

/** 涵蓋邊界由誰決定。UI 用它告訴使用者「為什麼這個圈是這麼大」。 */
export type LimitingFactor = 'kinematics' | 'horizon' | 'terrain' | 'altitude-limit';

export interface CoverageOptions {
  system: WeaponSystem;
  /** 目標高度 (m, 海平面基準)。 */
  altitudeM: number;
  /** 陣地地面高程 (m)。Phase 1 由使用者輸入，Phase 2 起由 DEM 提供。 */
  siteGroundElevationM: number;
  mode?: EstimateMode;
  aspect?: Aspect;
  kFactor?: number;
  azimuthCount?: number;
  /** Phase 2：接上 MVA 場後，逐方位套用地形遮蔽。 */
  mva?: MvaField | null;
}

export interface CoverageResult {
  /** 逐方位角的外半徑 (m)，索引 i 對應方位 i·360/n。 */
  outerM: Float64Array;
  /** 逐方位角的內半徑 (m)，即最小射程死區。 */
  innerM: Float64Array;
  azimuthCount: number;
  /** 主要限制因素（取各方位中最常見者）。 */
  limitedBy: LimitingFactor;
  kinematicMaxM: number;
  horizonMaxM: number;
  /** 是否完全無涵蓋（高度超出系統上下限）。 */
  empty: boolean;
}

const EMPTY: CoverageResult = {
  outerM: new Float64Array(0),
  innerM: new Float64Array(0),
  azimuthCount: 0,
  limitedBy: 'altitude-limit',
  kinematicMaxM: 0,
  horizonMaxM: 0,
  empty: true,
};

/**
 * 感測器天線的相對地面架高 (m)。
 *
 * 無有機感測器的系統（純射手）暫以 10 m 代表最低限度的本地觀測；
 * Phase 3 接上 C2 群組後，改由實際供軌的感測器決定。
 *
 * 這個值同時被涵蓋計算與 MVA 場計算使用，所以必須集中在一處 ——
 * 兩邊若用不同的架高，涵蓋圈與地形遮蔽會對不起來，而且很難察覺。
 */
export function antennaHeightAglM(system: WeaponSystem): number {
  return system.sensor ? system.sensor.antenna_height_m.nominal : 10;
}

export function computeCoverage(opts: CoverageOptions): CoverageResult {
  const {
    system,
    altitudeM,
    siteGroundElevationM,
    mode = 'nominal',
    aspect = 'head_on',
    kFactor = DEFAULT_K_FACTOR,
    azimuthCount = 360,
    mva = null,
  } = opts;

  // 明確的簡化：運動學包絡一律以**絕對高度（海平面基準）**查表，
  // 陣地高程只影響地平線，不影響包絡。
  //
  // 理由：公開推估的射程本身有 ±40% 的不確定度，為了一個 1 km 的發射點高差
  // 去修正 ±60 km 的數字是假精確。alt_limits 的 45 km 天花板與 50 m 最低攔截高度
  // 在公開資料裡本來就是絕對高度。此簡化寫在這裡，不藏在別處。
  const kin = kinematicRange(system, altitudeM, mode, aspect);
  if (!kin || kin.rMaxM <= 0) return EMPTY;

  const antennaAglM = antennaHeightAglM(system);
  const horizonM = radarHorizonRangeM(
    siteGroundElevationM + antennaAglM,
    Math.max(0, altitudeM),
    kFactor,
  );

  const outerM = new Float64Array(azimuthCount);
  const innerM = new Float64Array(azimuthCount);
  let terrainLimitedCount = 0;

  for (let i = 0; i < azimuthCount; i++) {
    let r = Math.min(kin.rMaxM, horizonM);

    if (mva) {
      // Phase 2：沿此方位向外推進，找到第一個目標高度低於 MVA 的距離。
      //
      // 超出 MVA 場半徑時用 extrapolatedMvaAt 外推邊界射線，而不是當成
      // 「沒有遮蔽」。早期版本在此把掃描切在場邊界，結果涵蓋圈會出現一段
      // 完美圓弧 —— 看起來像地形效果，其實是資料範圍的邊界。
      const az = (i * 360) / azimuthCount;
      const step = mva.rangeStepM;
      let visibleTo = 0;
      for (let rr = step; rr <= r; rr += step) {
        if (extrapolatedMvaAt(mva, az, rr) > altitudeM) break;
        visibleTo = rr;
      }
      if (visibleTo < r) {
        terrainLimitedCount++;
        r = visibleTo;
      }
    }

    outerM[i] = r;
    innerM[i] = Math.min(kin.rMinM, r);
  }

  let limitedBy: LimitingFactor;
  if (terrainLimitedCount > azimuthCount / 2) limitedBy = 'terrain';
  else if (horizonM < kin.rMaxM) limitedBy = 'horizon';
  else limitedBy = 'kinematics';

  return {
    outerM,
    innerM,
    azimuthCount,
    limitedBy,
    kinematicMaxM: kin.rMaxM,
    horizonMaxM: horizonM,
    empty: false,
  };
}
