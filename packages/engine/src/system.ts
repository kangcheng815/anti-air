/**
 * 武器系統目錄的型別定義。與 data/schema/system.schema.json 一一對應。
 * schema 是給資料驗證用的，這裡是給編譯器用的，兩者必須同步修改。
 */

import type { Estimate } from './estimate.js';

export type Tier = 'high' | 'medium' | 'short' | 'point';
export type Role = 'sam' | 'abm' | 'gun' | 'ciws' | 'sensor_only';
export type Platform = 'fixed' | 'semi-mobile' | 'mobile' | 'naval';
export type TargetClass =
  | 'aircraft' | 'helo' | 'uav' | 'cruise_missile' | 'tbm' | 'arm' | 'rocket';

export type GuidanceType =
  | 'active_rf' | 'sarh' | 'trackvialaunch' | 'clos' | 'ir' | 'beam_riding' | 'ballistic';

/** 接近幾何對有效射程的乘數。 */
export type Aspect = 'head_on' | 'beam' | 'tail_chase';

export interface EnvelopePoint {
  alt_km: number;
  r_max: Estimate;
  r_min?: Estimate;
}

export interface Kinematics {
  /** 依 alt_km 遞增排序。中間值線性內插，兩端夾住不外插。 */
  envelope: EnvelopePoint[];
  alt_limits: { min_km: number; max_km: number };
  aspect_factor?: Partial<Record<Aspect, number>>;
}

export interface Guidance {
  type: GuidanceType;
  requires_illumination: boolean;
  uplink_required?: boolean;
}

export interface SensorSpec {
  antenna_height_m: Estimate;
  r_det_ref_km: Estimate;
  rcs_ref_m2?: number;
  /** [下界, 上界] 度。上界造成陣地正上方的「靜默錐」。 */
  elevation_limits_deg?: [number, number];
  /** [[from, to], ...] 度；留空代表 360°。 */
  azimuth_mask_deg?: number[][];
}

export interface EngagementSpec {
  reaction_s: Estimate;
  channels: Estimate;
  assess_s?: Estimate;
  avg_missile_speed_mps?: Estimate;
  ready_rounds?: Estimate;
  /**
   * 每次接戰消耗的彈數。飛彈系統為 1（再乘上使用者選的齊射數），
   * 火砲為一次連射的發數 —— 砲的 ready_rounds 以「發」計，
   * 若不換算，238 發會被當成 238 次接戰機會，把飽和分析整個算歪。
   */
  rounds_per_engagement?: Estimate;
}

export interface WeaponSystem {
  id: string;
  name_zh: string;
  name_en?: string;
  tier: Tier;
  role: Role[];
  platform?: Platform;
  kinematics: Kinematics;
  guidance: Guidance;
  sensor?: SensorSpec | null;
  engagement: EngagementSpec;
  targets?: TargetClass[];
  render?: { hue?: number; z_order?: number };
}
