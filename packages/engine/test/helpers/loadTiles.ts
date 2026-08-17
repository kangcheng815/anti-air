/**
 * Node 端的圖磚載入，只給測試用。
 *
 * 有了它，MVA 引擎就能對**真實中央山脈**跑回歸測試，而不是只對合成的一道牆。
 * 這是 Phase 2 最重要的驗證手段：合成地形能證明公式沒寫錯，
 * 但只有真實 DEM 能證明投影、圖磚索引、內插這一整條鏈沒接歪。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import {
  TileTerrainSampler,
  decodeTerrarium,
  tileId,
  tilesCovering,
  type TileKey,
} from '../../src/terrain.js';

const TERRAIN_DIR = fileURLToPath(
  new URL('../../../app/public/terrain', import.meta.url),
);

export const TERRAIN_ZOOM = 11;

/** 地形資料是 gitignore 的產物，沒跑過 fetch-terrain 就不該讓測試整批爆掉。 */
export function terrainAvailable(): boolean {
  return existsSync(join(TERRAIN_DIR, 'manifest.json'));
}

function loadTile(key: TileKey): Int16Array | null {
  const path = join(TERRAIN_DIR, String(key.z), String(key.x), `${key.y}.png`);
  if (!existsSync(path)) return null;
  const png = PNG.sync.read(readFileSync(path));
  return decodeTerrarium(png.data, png.width);
}

export function samplerFor(
  center: { lon: number; lat: number },
  radiusM: number,
  zoom = TERRAIN_ZOOM,
): TileTerrainSampler {
  const tiles = new Map<string, Int16Array>();
  for (const key of tilesCovering(center, radiusM, zoom)) {
    const data = loadTile(key);
    if (data) tiles.set(tileId(key.z, key.x, key.y), data);
  }
  return new TileTerrainSampler(tiles, zoom);
}
