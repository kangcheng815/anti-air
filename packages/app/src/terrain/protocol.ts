/** Worker 與主執行緒之間的訊息型別。兩邊都 import 這一份，避免各寫各的。 */

import type { MvaField } from '@anti-air/engine';

export interface MvaRequest {
  id: string;
  lon: number;
  lat: number;
  antennaHeightM: number;
  maxRangeM: number;
  rangeStepM: number;
  azimuthCount: number;
  zoom: number;
  /** 圖磚基底路徑，例如 '/terrain'。 */
  terrainBaseUrl: string;
}

export interface MvaSuccess {
  id: string;
  ok: true;
  field: MvaField;
  /** DEM 在陣地座標的地面高程 (m)，用來自動帶入陣地高程。 */
  demElevationM: number;
  /** 缺磚數。>0 代表計算範圍超出已下載的地形資料。 */
  missingTiles: number;
  tilesUsed: number;
  computeMs: number;
}

export interface MvaFailure {
  id: string;
  ok: false;
  error: string;
}

export type MvaResponse = MvaSuccess | MvaFailure;

/** 沿一條線取地形剖面。圖磚快取在 worker 裡，所以取樣也必須在 worker 做。 */
export interface ProfileRequest {
  id: string;
  kind: 'profile';
  from: [number, number];
  to: [number, number];
  samples: number;
  zoom: number;
  terrainBaseUrl: string;
}

export interface ProfileSuccess {
  id: string;
  ok: true;
  kind: 'profile';
  /** 每個取樣點的地表高程 (m)。 */
  elevationsM: Float32Array;
  /** 取樣點座標，供逐點接戰判定使用。 */
  lons: Float64Array;
  lats: Float64Array;
  /** 線段總長 (m)。 */
  lengthM: number;
  missingTiles: number;
}

export type WorkerRequest = MvaRequest | ProfileRequest;
export type WorkerResponse = MvaResponse | ProfileSuccess | MvaFailure;

export function isProfileRequest(r: WorkerRequest): r is ProfileRequest {
  return (r as ProfileRequest).kind === 'profile';
}
