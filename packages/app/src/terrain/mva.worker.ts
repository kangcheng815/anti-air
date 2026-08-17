/// <reference lib="webworker" />
/**
 * MVA 計算 worker。
 *
 * 放在 worker 裡的原因不是「計算很慢」（實測 100 km 場約 120 ms），
 * 而是它是**同步且不可中斷**的緊迴圈：跑在主執行緒上會讓拖曳陣地時整個 UI 卡住 120 ms，
 * 那正好是使用者最需要即時回饋的時刻。
 *
 * 圖磚快取活在 worker 裡並跨請求保留 —— 移動同一個陣地時，
 * 絕大多數圖磚都已解碼好，第二次之後幾乎只剩純計算時間。
 */

import {
  computeMvaField,
  decodeTerrarium,
  localOffsetM,
  tileId,
  tilesCovering,
  TileTerrainSampler,
  TILE_SIZE,
  type TileKey,
} from '@anti-air/engine';
import {
  isProfileRequest,
  type MvaFailure,
  type MvaResponse,
  type ProfileRequest,
  type ProfileSuccess,
  type WorkerRequest,
} from './protocol';

const tileCache = new Map<string, Int16Array | null>();
const inflight = new Map<string, Promise<void>>();

/** 快取上限。每磚 256×256 Int16 = 128 KB，600 磚約 77 MB。 */
const MAX_CACHED_TILES = 600;

async function loadTile(key: TileKey, baseUrl: string): Promise<void> {
  const id = tileId(key.z, key.x, key.y);
  if (tileCache.has(id)) return;

  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    try {
      const res = await fetch(`${baseUrl}/${key.z}/${key.x}/${key.y}.png`);
      if (!res.ok) {
        // 404 是正常情況：計算範圍延伸到未下載的區域（通常是外海）。
        tileCache.set(id, null);
        return;
      }
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('OffscreenCanvas 2d context 取得失敗');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      tileCache.set(id, decodeTerrarium(data));
    } catch {
      tileCache.set(id, null);
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

function evictIfNeeded() {
  if (tileCache.size <= MAX_CACHED_TILES) return;
  // Map 保持插入順序，砍最舊的一批即可（近似 LRU，對「拖曳陣地」這種
  // 空間局部性很強的存取模式已經夠用）。
  const excess = tileCache.size - MAX_CACHED_TILES;
  let i = 0;
  for (const key of tileCache.keys()) {
    if (i++ >= excess) break;
    tileCache.delete(key);
  }
}

/** 沿線取地形剖面。取樣點在球面上線性內插，短距離下與大地線差異可忽略。 */
async function handleProfile(req: ProfileRequest): Promise<void> {
  const [lon1, lat1] = req.from;
  const [lon2, lat2] = req.to;

  // 先把整條線的圖磚載齊：以中點為圓心、半長為半徑，必然涵蓋整條線。
  const mid = { lon: (lon1 + lon2) / 2, lat: (lat1 + lat2) / 2 };
  const { dx, dy } = localOffsetM({ lon: lon1, lat: lat1 }, { lon: lon2, lat: lat2 });
  const lengthM = Math.hypot(dx, dy);
  const keys = tilesCovering(mid, lengthM / 2 + 2000, req.zoom);
  await Promise.all(keys.map((k) => loadTile(k, req.terrainBaseUrl)));

  const tiles = new Map<string, Int16Array>();
  for (const k of keys) {
    const data = tileCache.get(tileId(k.z, k.x, k.y));
    if (data) tiles.set(tileId(k.z, k.x, k.y), data);
  }
  const sampler = new TileTerrainSampler(tiles, req.zoom);

  const n = req.samples;
  const elevationsM = new Float32Array(n);
  const lons = new Float64Array(n);
  const lats = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const lon = lon1 + (lon2 - lon1) * t;
    const lat = lat1 + (lat2 - lat1) * t;
    lons[i] = lon;
    lats[i] = lat;
    elevationsM[i] = sampler.elevationAt(lon, lat);
  }

  const response: ProfileSuccess = {
    id: req.id,
    ok: true,
    kind: 'profile',
    elevationsM,
    lons,
    lats,
    lengthM,
    missingTiles: keys.length - tiles.size,
  };
  (self as unknown as Worker).postMessage(response, [
    elevationsM.buffer,
    lons.buffer,
    lats.buffer,
  ]);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  if (isProfileRequest(req)) {
    try {
      await handleProfile(req);
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies MvaFailure);
    }
    return;
  }

  try {
    const center = { lon: req.lon, lat: req.lat };
    const keys = tilesCovering(center, req.maxRangeM, req.zoom);
    await Promise.all(keys.map((k) => loadTile(k, req.terrainBaseUrl)));

    const tiles = new Map<string, Int16Array>();
    for (const k of keys) {
      const id = tileId(k.z, k.x, k.y);
      const data = tileCache.get(id);
      if (data) tiles.set(id, data);
    }
    evictIfNeeded();

    const sampler = new TileTerrainSampler(tiles, req.zoom);
    const demElevationM = sampler.elevationAt(req.lon, req.lat);

    const t0 = performance.now();
    const field = computeMvaField(center, sampler, {
      antennaHeightM: req.antennaHeightM,
      maxRangeM: req.maxRangeM,
      rangeStepM: req.rangeStepM,
      azimuthCount: req.azimuthCount,
    });
    const computeMs = performance.now() - t0;

    const response: MvaResponse = {
      id: req.id,
      ok: true,
      field,
      demElevationM,
      missingTiles: keys.length - tiles.size,
      tilesUsed: tiles.size,
      computeMs,
    };
    // 把 Float32Array 的緩衝區轉移而非複製：1.4 MB 的場不該再拷貝一次。
    (self as unknown as Worker).postMessage(response, [field.data.buffer]);
  } catch (e) {
    const response: MvaResponse = {
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
