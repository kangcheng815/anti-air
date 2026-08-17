/** 威脅剖面。對應 data/threats.json。 */

import type { Estimate } from './estimate.js';
import type { TargetClass } from './system.js';

export interface Threat {
  id: string;
  name_zh: string;
  class: TargetClass;
  rcs_m2: Estimate;
  typical_altitude_m: number;
  speed_mps: Estimate;
  note?: string;
}

/** 雷達方程的四次方根律：偵測距離 ∝ RCS^(1/4)。 */
export function detectionRangeM(
  refRangeKm: number,
  refRcsM2: number,
  targetRcsM2: number,
): number {
  if (targetRcsM2 <= 0 || refRcsM2 <= 0) return 0;
  return refRangeKm * 1000 * Math.pow(targetRcsM2 / refRcsM2, 0.25);
}
