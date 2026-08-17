/**
 * 地形遮蔽圖層：把 MVA 場本身畫出來。
 *
 * 顯示的是「在這一格，目標至少要飛多高才會被這個陣地看到」。
 * 涵蓋圖回答「打不打得到」，這一層回答「為什麼打不到」——
 * 低空走廊在這張圖上是一條連續的深色帶。
 *
 * 只畫**選取中的那一個陣地**。多個陣地的 MVA 疊在一起沒有意義：
 * MVA 不能相加，多站聯合的正確運算是逐點取最小值，那是 Phase 3 縱深熱圖的工作。
 */

import type { MvaField } from '@anti-air/engine';
import { mvaAt, mvaExtentM } from '@anti-air/engine';
import { DEG } from '@anti-air/engine';

/** 輸出畫布邊長。512 足以看清主要山脊，且一次重繪約 30 ms。 */
const SIZE = 512;

export interface ShadowRender {
  /** PNG data URI。餵給 MapLibre 的 `image` 來源，不用 `canvas` 來源，理由見下。 */
  url: string;
  /** MapLibre ImageSource 要的四角，順序為 左上、右上、右下、左下。 */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * 色階：最低可視高度分段。
 * 越暗代表要飛越高才會被看到，也就是遮蔽越深。
 * 用離散分段而非連續漸層，是為了讓「100 m / 500 m / 3 km」這些
 * 有實際意義的門檻在圖上看得出邊界。
 */
export const SHADOW_BANDS: { maxM: number; color: [number, number, number]; label: string }[] = [
  { maxM: 100, color: [255, 255, 204], label: '< 100 m' },
  { maxM: 300, color: [199, 233, 180], label: '100–300 m' },
  { maxM: 1000, color: [127, 205, 187], label: '300 m–1 km' },
  { maxM: 3000, color: [65, 152, 180], label: '1–3 km' },
  { maxM: 8000, color: [44, 96, 154], label: '3–8 km' },
  { maxM: Infinity, color: [25, 44, 97], label: '> 8 km' },
];

const ALPHA = 165;

function bandColor(mvaM: number): [number, number, number] {
  for (const b of SHADOW_BANDS) if (mvaM < b.maxM) return b.color;
  return SHADOW_BANDS[SHADOW_BANDS.length - 1].color;
}

// Web Mercator 的 y 座標（歸一化 0–1），用來讓影像與底圖的投影一致。
function latToMercY(lat: number): number {
  const r = lat * DEG;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

function mercYToLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * 把 MVA 場算成一張疊圖。
 *
 * 影像在 **Mercator 空間**上均勻取樣，因為 MapLibre 的 CanvasSource 是把四角
 * 投到 Mercator 後線性內插。若改在等距經緯度上取樣，影像會相對底圖上下錯位，
 * 在台灣的緯度跨距下足以造成公里級的偏差 —— 而這正是地形圖層最不能出的錯。
 */
export function renderShadow(field: MvaField): ShadowRender {
  const extentM = mvaExtentM(field);
  const { lon: cLon, lat: cLat } = field.center;

  const dLat = (extentM / 111_320) * 1.02;
  const dLon = (extentM / (111_320 * Math.cos(cLat * DEG))) * 1.02;

  const west = cLon - dLon;
  const east = cLon + dLon;
  const north = Math.min(85, cLat + dLat);
  const south = Math.max(-85, cLat - dLat);

  const yNorth = latToMercY(north);
  const ySouth = latToMercY(south);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const px = img.data;

  // 本地平面近似：在 120 km 尺度上，方位與距離的誤差遠小於一個像素。
  const mPerDegLat = 110_574;
  const mPerDegLon = 111_320 * Math.cos(cLat * DEG);

  for (let row = 0; row < SIZE; row++) {
    const my = yNorth + ((ySouth - yNorth) * (row + 0.5)) / SIZE;
    const lat = mercYToLat(my);
    const dy = (lat - cLat) * mPerDegLat;

    for (let col = 0; col < SIZE; col++) {
      const lon = west + ((east - west) * (col + 0.5)) / SIZE;
      const dx = (lon - cLon) * mPerDegLon;

      const r = Math.hypot(dx, dy);
      const o = (row * SIZE + col) * 4;

      if (r > extentM) {
        px[o + 3] = 0; // 場外：完全透明，不要假裝有資料
        continue;
      }

      const az = (Math.atan2(dx, dy) * 180) / Math.PI;
      const mva = mvaAt(field, az < 0 ? az + 360 : az, r);
      const [cr, cg, cb] = bandColor(Math.max(0, mva));
      px[o] = cr;
      px[o + 1] = cg;
      px[o + 2] = cb;
      px[o + 3] = ALPHA;
    }
  }

  ctx.putImageData(img, 0, 0);

  // 為什麼要多繞一層 PNG 編碼，而不是直接把 canvas 交給 MapLibre 的 `canvas` 來源：
  //
  // 實測 CanvasSource 上傳的是**全黑材質** —— 一張純紅的 canvas 經由
  // `type: 'canvas'` 來源畫出來是 (17,19,21)，同一張 canvas 經 toDataURL 走
  // `type: 'image'` 來源畫出來是 (246,19,21)。症狀是整個圖層變成一片黑色矩形。
  //
  // 編碼成本 512×512 約 32 ms，相對於本函式本身的計算量可以接受，
  // 而且 image 來源的生命週期比 canvas 來源單純（不需要煩惱何時重傳材質）。
  return {
    url: canvas.toDataURL('image/png'),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}
