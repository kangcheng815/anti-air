/**
 * 讓每個陣地的 MVA 場跟著陣地狀態走。
 *
 * 核心是一個「輸入指紋」key：只要位置或天線架高變了，key 就變，舊結果作廢。
 * 高度滑桿**不在 key 裡** —— 這是 MVA 設計的整個重點：
 * 場算一次，所有高度切片共用，拉滑桿不觸發任何重算。
 */

import { useEffect } from 'react';
import { antennaHeightAglM, peakRangeM } from '@anti-air/engine';
import { BY_ID } from '../data/catalog';
import { useStore, type Site } from '../state/store';
import {
  loadManifest,
  mvaClient,
  AZIMUTH_COUNT,
  MAX_TERRAIN_RANGE_M,
  MIN_TERRAIN_RANGE_M,
  RANGE_STEP_M,
  TERRAIN_BASE_URL,
} from './mvaClient';

function fingerprint(site: Site, antennaM: number, rangeM: number, zoom: number): string {
  return `${site.lon.toFixed(5)},${site.lat.toFixed(5)},${antennaM},${rangeM},${zoom}`;
}

/** MVA 場只需算到涵蓋可能到達的距離，再遠的地形不會影響任何一個圈。 */
function terrainRangeFor(systemId: string): number {
  const system = BY_ID.get(systemId);
  if (!system) return MIN_TERRAIN_RANGE_M;
  const peak = peakRangeM(system, 'optimistic');
  return Math.min(MAX_TERRAIN_RANGE_M, Math.max(MIN_TERRAIN_RANGE_M, peak));
}

export function useTerrainSync() {
  const sites = useStore((s) => s.sites);
  const manifest = useStore((s) => s.terrainManifest);
  const terrainChecked = useStore((s) => s.terrainChecked);
  const terrainEnabled = useStore((s) => s.terrainEnabled);

  // 啟動時檢查地形資料是否存在。
  useEffect(() => {
    loadManifest().then((m) => useStore.getState().setTerrainManifest(m));
  }, []);

  useEffect(() => {
    if (!terrainChecked || !manifest || !terrainEnabled) return;

    for (const site of sites) {
      const system = BY_ID.get(site.systemId);
      if (!system) continue;

      const antennaM = antennaHeightAglM(system);
      const rangeM = terrainRangeFor(site.systemId);
      const key = fingerprint(site, antennaM, rangeM, manifest.zoom);

      const existing = useStore.getState().mva[site.id];
      if (existing && existing.key === key) continue;

      useStore.getState().setMvaEntry(site.id, { key, status: 'pending' });

      mvaClient
        .request({
          id: `${site.id}:${key}`,
          lon: site.lon,
          lat: site.lat,
          antennaHeightM: antennaM,
          maxRangeM: rangeM,
          rangeStepM: RANGE_STEP_M,
          azimuthCount: AZIMUTH_COUNT,
          zoom: manifest.zoom,
          terrainBaseUrl: TERRAIN_BASE_URL,
        })
        .then((res) => {
          const store = useStore.getState();
          // 期間陣地可能又被移動或刪除，結果已經沒有意義。
          const current = store.mva[site.id];
          if (!current || current.key !== key) return;
          if (!store.sites.some((s) => s.id === site.id)) return;

          store.setMvaEntry(site.id, {
            key,
            status: 'ready',
            field: res.field,
            demElevationM: res.demElevationM,
            missingTiles: res.missingTiles,
            computeMs: res.computeMs,
          });

          // DEM 高程自動帶入，除非使用者手動改過。
          const live = store.sites.find((s) => s.id === site.id);
          if (live && live.elevationSource === 'dem') {
            const dem = Math.round(res.demElevationM);
            if (dem !== live.groundElevationM) {
              store.updateSite(site.id, { groundElevationM: dem });
            }
          }
        })
        .catch((e: Error) => {
          const store = useStore.getState();
          const current = store.mva[site.id];
          if (!current || current.key !== key) return;
          store.setMvaEntry(site.id, { key, status: 'error', error: e.message });
        });
    }
  }, [sites, manifest, terrainChecked, terrainEnabled]);
}
