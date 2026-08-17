/**
 * 不確定度是型別，不是註解。
 *
 * 所有物理量都用 Estimate 包起來，程式中任何地方都拿不到裸數字，
 * 必須先明確表態要用哪一種估計。這讓「保守/標稱/樂觀」不是事後補的 UI 開關，
 * 而是資料流上一個無法繞過的關卡。
 */

export type Confidence = 'low' | 'medium' | 'high';

export interface Estimate {
  min?: number;
  nominal: number;
  max?: number;
  confidence: Confidence;
  sources?: string[];
  note?: string;
}

/**
 * 估計模式。
 * - conservative：對防守方不利的一端（射程取 min、反應時間取 max）
 * - nominal：標稱值
 * - optimistic：對防守方有利的一端
 *
 * 注意 conservative 對「射程」是取 min、對「反應時間」是取 max —— 方向相反。
 * 所以解析時必須指明這個量是「越大越好」還是「越小越好」。
 */
export type EstimateMode = 'conservative' | 'nominal' | 'optimistic';

/** 量的方向：higher = 數值越大對防守方越有利（射程、通道數）。 */
export type Polarity = 'higher' | 'lower';

export function resolve(
  estimate: Estimate,
  mode: EstimateMode,
  polarity: Polarity = 'higher',
): number {
  if (mode === 'nominal') return estimate.nominal;

  const wantLow = (mode === 'conservative') === (polarity === 'higher');
  const picked = wantLow ? estimate.min : estimate.max;
  return picked ?? estimate.nominal;
}

/** 估計值是否有可展示的區間（用來決定要不要畫不確定度帶）。 */
export function hasSpread(estimate: Estimate): boolean {
  return (
    estimate.min !== undefined &&
    estimate.max !== undefined &&
    estimate.max > estimate.min
  );
}
