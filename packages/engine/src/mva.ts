/**
 * MVA — Minimum Visible Altitude（最低可視高度）
 *
 * 這是整個引擎的核心資料結構，也是本專案與「畫圓派」最大的分野。
 *
 * 對每個陣地，我們計算一張極座標場：
 *
 *     MVA(φ, r) = 目標必須飛到多高，才能被位於原點的感測器直視
 *
 * 它同時把三件事編碼進同一個數字：
 *   1. 地球曲率（雷達地平線）
 *   2. 大氣折射（k = 4/3 有效地球半徑）
 *   3. 地形遮蔽（沿著射線的最大仰角）
 *
 * 關鍵性質：**算一次，所有高度切片同時得到**。
 * 高度滑桿拉到 h 時，可視區域就是 { (φ,r) : h ≥ MVA(φ,r) } —— 一次逐點比較而已。
 * 這讓「拖曳陣地即時重算遮蔽」變得可行，也就不需要離線預算 viewshed。
 * 見 DESIGN.md §3。
 *
 * 驗證：地形全平（海面）時，本式必須還原教科書的雷達地平線
 *     d(km) = 4.12 (√h₁ + √h₂)
 * 這條性質有解析解單元測試把關，見 test/mva.test.ts。
 */

import { destination, type LonLat } from './geodesy.js';

/** 地球平均半徑 (m)，IUGG 算術平均。 */
export const EARTH_RADIUS_M = 6371008.8;

/**
 * 有效地球半徑因子。標準大氣下折射使射線微彎向地面，
 * 等效於把地球放大 4/3 倍。異常傳播（大氣導管）時可拉到 2~5，做為敏感度分析參數。
 */
export const DEFAULT_K_FACTOR = 4 / 3;

/** 地表取樣器。海面請回傳 0（DEM 的 nodata 一律當海）。 */
export interface TerrainSampler {
  elevationAt(lonDeg: number, latDeg: number): number;
}

export interface MvaParams {
  /** 天線相對「地面」的架高 (m)。絕對高度 = DEM(陣地) + antennaHeightM。 */
  antennaHeightM: number;
  /** 最大計算距離 (m)。 */
  maxRangeM: number;
  /** 距離分箱寬度 (m)。90 m DEM 建議 100~200 m。 */
  rangeStepM: number;
  /** 方位角取樣數。720 = 0.5° 解析度，在 100 km 處橫向間距約 873 m。 */
  azimuthCount: number;
  /** 有效地球半徑因子。 */
  kFactor?: number;
}

export interface MvaField {
  center: LonLat;
  /** 感測器絕對高度 (m, 海平面基準)。 */
  siteElevationM: number;
  azimuthCount: number;
  rangeBins: number;
  rangeStepM: number;
  kFactor: number;
  /**
   * 展平的 [azimuth][range] 場，單位公尺。
   * 值 = 該方位、該距離上，目標的最低可視高度（海平面基準）。
   * 負值代表連海平面以下都看得到（近距離下坡地形），使用時夾到 0。
   */
  data: Float32Array;
}

/** 曲率 + 折射造成的視覺下沉量 (m)。 */
export function curvatureDrop(rangeM: number, kFactor = DEFAULT_K_FACTOR): number {
  return (rangeM * rangeM) / (2 * kFactor * EARTH_RADIUS_M);
}

/**
 * 平坦地形（海面）上的雷達地平線距離 (m)。
 *
 * 這是 computeMvaField 在 z ≡ 0 時的解析特例，等價於教科書的
 *     d(km) = 4.12 (√h₁ + √h₂)
 * 但係數不寫死：4.12 就是 √(2·k·Re)/1000，k 可調就自動跟著變。
 *
 * Phase 1 尚無 DEM 時用它取代完整 MVA 場；Phase 2 之後只用於驗證與海上陣地。
 */
export function radarHorizonRangeM(
  antennaHeightM: number,
  targetHeightM: number,
  kFactor = DEFAULT_K_FACTOR,
): number {
  const c = Math.sqrt(2 * kFactor * EARTH_RADIUS_M);
  return c * (Math.sqrt(Math.max(0, antennaHeightM)) + Math.sqrt(Math.max(0, targetHeightM)));
}

/**
 * 沿徑向掃描計算 MVA 場。
 *
 * 演算法：對每條方位射線，由近至遠推進，維護一個「到目前為止的最大仰角 θmax」。
 * θmax 可以是負的（居高臨下看海時就是負的），這正是雷達地平線比水平線遠的原因，
 * 也是為什麼本式能自然還原 4.12(√h₁+√h₂) 而不用另外套公式。
 *
 * 複雜度 O(azimuthCount × rangeBins)。720 × 500 = 36 萬次 DEM 取樣，
 * 在 Web Worker 中約數十毫秒，足以支撐拖曳互動。
 */
export function computeMvaField(
  center: LonLat,
  terrain: TerrainSampler,
  params: MvaParams,
): MvaField {
  const k = params.kFactor ?? DEFAULT_K_FACTOR;
  const nAz = params.azimuthCount;
  const nR = Math.floor(params.maxRangeM / params.rangeStepM);
  const siteElevationM = terrain.elevationAt(center.lon, center.lat) + params.antennaHeightM;

  const data = new Float32Array(nAz * nR);

  for (let ia = 0; ia < nAz; ia++) {
    const azimuth = (ia * 360) / nAz;
    let thetaMax = -Infinity;

    for (let ir = 0; ir < nR; ir++) {
      const r = (ir + 1) * params.rangeStepM;
      const p = destination(center, azimuth, r);
      const z = terrain.elevationAt(p.lon, p.lat);

      // 地形點的視仰角：先把曲率下沉從高程扣掉，再取 atan。
      const theta = Math.atan2(z - curvatureDrop(r, k) - siteElevationM, r);
      if (theta > thetaMax) thetaMax = theta;

      // 沿 θmax 射線在距離 r 處的高度，再加回曲率下沉，即為最低可視高度。
      data[ia * nR + ir] = siteElevationM + r * Math.tan(thetaMax) + curvatureDrop(r, k);
    }
  }

  return {
    center,
    siteElevationM,
    azimuthCount: nAz,
    rangeBins: nR,
    rangeStepM: params.rangeStepM,
    kFactor: k,
    data,
  };
}

/** MVA 場的計算半徑 (m)。超過這個距離沒有地形資訊，不等於被遮蔽。 */
export function mvaExtentM(field: MvaField): number {
  return field.rangeBins * field.rangeStepM;
}

/**
 * 查詢 MVA，超出場的計算半徑時**外推**而非放棄。
 *
 * 為什麼要外推：場邊界之外若退回平坦地形，等於假裝山突然消失了。
 * 實測症狀是中央山脈背後 130 km 處的低空目標會被判為「看得到」——
 * 明明視線早在 40 km 處就被 3000 m 的稜線切斷了。
 *
 * 正確做法：θmax 沿射線是單調不減的，所以場邊界上的 θmax 對更遠處仍然成立
 * （只會低估遮蔽，不會高估）。把邊界的射線延長出去即可：
 *
 *     tan(θedge) = (MVA(extent) − h_site − c(extent)) / extent
 *     MVA(r)     = h_site + r·tan(θedge) + c(r)
 *
 * 這是保守且物理上有依據的外推，不是憑空補值。
 */
export function extrapolatedMvaAt(
  field: MvaField,
  azimuthDeg: number,
  rangeM: number,
): number {
  const extent = mvaExtentM(field);
  if (rangeM <= extent) return mvaAt(field, azimuthDeg, rangeM);

  const edge = mvaAt(field, azimuthDeg, extent);
  if (!Number.isFinite(edge)) return Infinity;

  const tanEdge =
    (edge - field.siteElevationM - curvatureDrop(extent, field.kFactor)) / extent;
  return field.siteElevationM + rangeM * tanEdge + curvatureDrop(rangeM, field.kFactor);
}

/** 查詢單點的 MVA (m)。超出計算範圍回傳 Infinity。 */
export function mvaAt(field: MvaField, azimuthDeg: number, rangeM: number): number {
  const ia =
    ((Math.round((azimuthDeg / 360) * field.azimuthCount) % field.azimuthCount) +
      field.azimuthCount) %
    field.azimuthCount;
  const ir = Math.floor(rangeM / field.rangeStepM) - 1;
  if (ir < 0) return -Infinity; // 站在自己頭上，一律可見
  if (ir >= field.rangeBins) return Infinity;
  return field.data[ia * field.rangeBins + ir];
}

/**
 * 取指定高度切片下、每個方位角的最大可視距離 (m)。
 * 輸出可直接餵給 geodesicRing() 畫出鋸齒狀的實際涵蓋多邊形。
 *
 * 注意取的是「最遠的連續可視距離」：遇到第一個遮蔽就停。
 * 山後可能還有第二段可視區（越過山頭再落下），那屬於 detached lobe，
 * 用 sliceMask() 取得完整遮罩，不要用本函式。
 */
export function visibleRangeAtAltitude(field: MvaField, altitudeM: number): Float32Array {
  const out = new Float32Array(field.azimuthCount);
  for (let ia = 0; ia < field.azimuthCount; ia++) {
    let last = 0;
    for (let ir = 0; ir < field.rangeBins; ir++) {
      if (field.data[ia * field.rangeBins + ir] > altitudeM) break;
      last = (ir + 1) * field.rangeStepM;
    }
    out[ia] = last;
  }
  return out;
}

/** 指定高度切片的完整可視遮罩（含山後的分離可視區）。1 = 可見。 */
export function sliceMask(field: MvaField, altitudeM: number): Uint8Array {
  const out = new Uint8Array(field.data.length);
  for (let i = 0; i < field.data.length; i++) {
    out[i] = field.data[i] <= altitudeM ? 1 : 0;
  }
  return out;
}
