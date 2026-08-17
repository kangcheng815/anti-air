/**
 * MVA worker 的主執行緒代理。
 *
 * 單一 worker、請求以 id 對應回覆。同一個陣地連續移動時，
 * 舊請求的結果會因為 key 不符而被丟棄（見 useTerrainSync），
 * 所以這裡不做取消 —— worker 端的圖磚快取讓重算成本已經很低。
 */

import type {
  MvaRequest,
  MvaSuccess,
  ProfileRequest,
  ProfileSuccess,
  WorkerRequest,
  WorkerResponse,
} from './protocol';

export interface TerrainManifest {
  zoom: number;
  bbox: { west: number; south: number; east: number; north: number };
  groundResolutionM: number;
  attribution: string;
  fetchedAt: string;
}

export const TERRAIN_BASE_URL = '/terrain';

/** MVA 場的最大計算半徑。超過此距離地形幾乎不再遮蔽（曲率主導），不值得付記憶體。 */
export const MAX_TERRAIN_RANGE_M = 120_000;
export const MIN_TERRAIN_RANGE_M = 30_000;
export const RANGE_STEP_M = 200;
export const AZIMUTH_COUNT = 720;

let manifestPromise: Promise<TerrainManifest | null> | null = null;

/** 載入地形 manifest。回傳 null 代表尚未下載地形資料。 */
export function loadManifest(): Promise<TerrainManifest | null> {
  manifestPromise ??= fetch(`${TERRAIN_BASE_URL}/manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<TerrainManifest>) : null))
    .catch(() => null);
  return manifestPromise;
}

class MvaClient {
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    { resolve: (r: never) => void; reject: (e: Error) => void }
  >();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./mva.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const entry = this.pending.get(e.data.id);
      if (!entry) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) entry.resolve(e.data as never);
      else entry.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      const error = new Error(e.message || 'MVA worker 發生錯誤');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private send<T>(req: WorkerRequest): Promise<T> {
    const worker = this.ensure();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as (r: never) => void, reject });
      worker.postMessage(req);
    });
  }

  request(req: MvaRequest): Promise<MvaSuccess> {
    return this.send<MvaSuccess>(req);
  }

  profile(req: ProfileRequest): Promise<ProfileSuccess> {
    return this.send<ProfileSuccess>(req);
  }
}

export const mvaClient = new MvaClient();
