/**
 * 系統目錄載入。
 *
 * data/systems/*.json 是唯一的參數來源 —— 程式碼中不得出現任何硬編碼的性能數字
 * （DESIGN.md §12）。新增一型系統就是新增一個 JSON 檔，不用改任何 .ts。
 */

import type { WeaponSystem, Tier } from '@anti-air/engine';

const modules = import.meta.glob<{ default: unknown }>('../../../../data/systems/*.json', {
  eager: true,
});

export const TIER_LABEL: Record<Tier, string> = {
  high: '高層／反彈道',
  medium: '區域中高層',
  short: '中短程',
  point: '極短程／點防禦',
};

const TIER_ORDER: Record<Tier, number> = { high: 0, medium: 1, short: 2, point: 3 };

const TIER_FALLBACK_HUE: Record<Tier, number> = {
  high: 210,
  medium: 140,
  short: 50,
  point: 0,
};

export const CATALOG: WeaponSystem[] = Object.values(modules)
  .map((m) => m.default as WeaponSystem)
  .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.id.localeCompare(b.id));

export const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));

export function hueOf(system: WeaponSystem): number {
  return system.render?.hue ?? TIER_FALLBACK_HUE[system.tier];
}

/** 涵蓋填色。透明度低、彼此疊加，重疊處自然變深。 */
export function fillColor(system: WeaponSystem): string {
  return `hsl(${hueOf(system)}, 75%, 55%)`;
}

export function strokeColor(system: WeaponSystem): string {
  return `hsl(${hueOf(system)}, 80%, 42%)`;
}
