/**
 * 底圖選項。
 *
 * 全部使用無需 API key 的第三方公開圖磚服務 —— 這代表 app 會對外連線取圖。
 * 若要完全離線，把 style 換成自架的 MBTiles / PMTiles 即可，其餘程式碼不用動。
 *
 * 涵蓋圖層是高飽和的半透明疊圖，所以底圖預設選低飽和的灰階樣式，
 * 避免底圖顏色跟涵蓋顏色打架。
 */

export interface Basemap {
  id: string;
  label: string;
  style: string;
  /** 深色底圖時，UI 疊字要換色。 */
  dark: boolean;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'positron',
    label: '淺灰（推薦）',
    style: 'https://tiles.openfreemap.org/styles/positron',
    dark: false,
  },
  {
    id: 'dark',
    label: '深色',
    style: 'https://tiles.openfreemap.org/styles/dark',
    dark: true,
  },
  {
    id: 'liberty',
    label: '街道細節',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    dark: false,
  },
  {
    id: 'demo',
    label: '極簡（離線備援）',
    style: 'https://demotiles.maplibre.org/style.json',
    dark: false,
  },
];

export const DEFAULT_BASEMAP = BASEMAPS[0];

export function basemapById(id: string): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? DEFAULT_BASEMAP;
}

/** 台灣本島 + 澎湖的預設視野。 */
export const TAIWAN_VIEW = {
  center: [120.98, 23.7] as [number, number],
  zoom: 6.6,
};
