/** 把 store 的陣地清單轉成引擎要的 SiteState。單一轉換點，避免各處各轉一份。 */

import type { SiteState } from '@anti-air/engine';
import { BY_ID } from '../data/catalog';
import type { C2Mode, MvaEntry, Site } from '../state/store';

export function toSiteStates(
  sites: Site[],
  mva: Record<string, MvaEntry>,
  terrainEnabled: boolean,
): SiteState[] {
  const out: SiteState[] = [];
  for (const s of sites) {
    if (s.status === 'down') continue;
    const system = BY_ID.get(s.systemId);
    if (!system) continue;
    const entry = mva[s.id];
    out.push({
      id: s.id,
      lon: s.lon,
      lat: s.lat,
      groundElevationM: s.groundElevationM,
      system,
      mva: terrainEnabled && entry?.status === 'ready' ? (entry.field ?? null) : null,
      readyRoundsOverride: s.readyRoundsOverride ?? undefined,
    });
  }
  return out;
}

/**
 * 某個射手可用的供軌感測器。
 *
 * 目前只有兩種模式，沒有做完整的 C2 群組編輯器 —— 那需要一整套 UI，
 * 而「全島共享」與「各自為政」這兩端已經能呈現感測器—射手分離的全部重點：
 * 真實情況一定落在兩者之間。C2Group 實體留在 DESIGN.md §5.2，尚未實作。
 */
export function sensorsFor(battery: SiteState, all: SiteState[], mode: C2Mode): SiteState[] {
  if (mode === 'independent') return battery.system.sensor ? [battery] : [];
  return all.filter((s) => s.system.sensor);
}
