/**
 * 地形取樣：把 Terrarium 編碼的 DEM 圖磚變成 computeMvaField 要的 TerrainSampler。
 *
 * 這一層必須是**同步**的，因為 MVA 的徑向掃描每條射線要連續取樣數百點，
 * 中間不能有 await。所以流程固定是：先非同步把需要的圖磚載齊 → 再同步跑 MVA。
 * 圖磚載入由呼叫端負責（瀏覽器用 fetch + createImageBitmap，Node 測試用假資料），
 * 本檔只管座標換算與內插。
 */

import type { TerrainSampler } from './mva.js';
import { DEG } from './geodesy.js';

export const TILE_SIZE = 256;

export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export function tileId(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Terrarium 編碼：elevation_m = (R·256 + G + B/256) − 32768。 */
export function decodeTerrarium(rgba: ArrayLike<number>, size = TILE_SIZE): Int16Array {
  const out = new Int16Array(size * size);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // 1 m 精度已遠超過參數本身的不確定度，直接取整省一半記憶體。
    out[i] = Math.round(rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768);
  }
  return out;
}

// ---------------------------------------------------------------- 投影

/** 經度 → 全域像素 X（Web Mercator，指定縮放層級）。 */
export function lonToPixelX(lon: number, z: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** z;
}

/** 緯度 → 全域像素 Y。 */
export function latToPixelY(lat: number, z: number): number {
  const r = lat * DEG;
  const s = Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI;
  return ((1 - s) / 2) * TILE_SIZE * 2 ** z;
}

/** 指定縮放層級、指定緯度下，一個像素代表的地面距離 (m)。 */
export function groundResolutionM(lat: number, z: number): number {
  return (40075016.686 * Math.cos(lat * DEG)) / (TILE_SIZE * 2 ** z);
}

/**
 * 涵蓋指定圓形範圍所需的圖磚清單。
 * 半徑換算成經緯度時取偏保守的估計，寧可多載一圈也不要在邊緣缺料。
 */
export function tilesCovering(
  center: { lon: number; lat: number },
  radiusM: number,
  z: number,
): TileKey[] {
  const dLat = (radiusM / 111_320) * 1.02;
  const dLon = (radiusM / (111_320 * Math.cos(center.lat * DEG))) * 1.02;

  const minX = Math.floor(lonToPixelX(center.lon - dLon, z) / TILE_SIZE);
  const maxX = Math.floor(lonToPixelX(center.lon + dLon, z) / TILE_SIZE);
  // 緯度越高像素 Y 越小，所以北界對應 minY。
  const minY = Math.floor(latToPixelY(center.lat + dLat, z) / TILE_SIZE);
  const maxY = Math.floor(latToPixelY(center.lat - dLat, z) / TILE_SIZE);

  const n = 2 ** z;
  const keys: TileKey[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (y < 0 || y >= n) continue;
      keys.push({ z, x: ((x % n) + n) % n, y });
    }
  }
  return keys;
}

// ---------------------------------------------------------------- 取樣器

/**
 * 以已解碼圖磚為後端的地形取樣器。
 *
 * 缺磚一律回傳 0（海）。這是刻意的：台灣周邊缺磚的地方就是外海，
 * 而把未知當成 0 在防空分析中是**不保守**的（低估遮蔽、高估涵蓋），
 * 所以 missingTiles 會被記錄下來，讓呼叫端能檢查是不是真的只缺海域。
 */
export class TileTerrainSampler implements TerrainSampler {
  readonly missingTiles = new Set<string>();

  constructor(
    private readonly tiles: Map<string, Int16Array>,
    private readonly zoom: number,
  ) {}

  /** 單一像素高程。海床測深值夾到 0 —— 雷達看到的是海面，不是海床。 */
  private pixel(px: number, py: number): number {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const key = tileId(this.zoom, tx, ty);
    const tile = this.tiles.get(key);
    if (!tile) {
      this.missingTiles.add(key);
      return 0;
    }
    const ix = px - tx * TILE_SIZE;
    const iy = py - ty * TILE_SIZE;
    return Math.max(0, tile[iy * TILE_SIZE + ix]);
  }

  elevationAt(lon: number, lat: number): number {
    const fx = lonToPixelX(lon, this.zoom) - 0.5;
    const fy = latToPixelY(lat, this.zoom) - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;

    // 雙線性內插。跨圖磚邊界時四個角可能來自不同磚，pixel() 會各自查表。
    const a = this.pixel(x0, y0);
    const b = this.pixel(x0 + 1, y0);
    const c = this.pixel(x0, y0 + 1);
    const d = this.pixel(x0 + 1, y0 + 1);

    return (
      a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
    );
  }
}
