/**
 * 縱深熱圖：每一格被幾套系統涵蓋。
 *
 * 這是整個工具最有價值的一層，但只有在**威脅條件化**之後才有意義。
 * 兩套系統都看不到 100 m 的小 RCS 目標時，該格的縱深是 0 而不是 2 ——
 * 把系統數量當成縱深，正是傳統涵蓋圖最誤導人的地方。
 *
 * 只在「至少有一套系統的運動學射程搆得到」的範圍內著色。
 * 在那個範圍之外畫紅色沒有資訊量；而在範圍**之內**的紅色，
 * 意思是「飛彈飛得到，但沒有人能接戰」—— 那才是真正的缺口。
 */

import {
  detectionCheck,
  kinematicRange,
  localOffsetM,
  shooterCheck,
  type EstimateMode,
  type Aspect,
  type SiteState,
  type Threat,
} from '@anti-air/engine';
import type { C2Mode } from '../state/store';
import { sensorsFor } from './siteStates';

/** 輸出解析度。256² = 65k 點，實測主執行緒約 100–300 ms，可接受。 */
const SIZE = 256;

export interface DepthRender {
  /** PNG data URI。用 MapLibre 的 `image` 來源，不用 `canvas` 來源（理由見 shadowLayer.ts）。 */
  url: string;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /** 各縱深層級的格數，供統計面板顯示。索引 0 = 缺口。 */
  histogram: number[];
  computeMs: number;
}

export const DEPTH_BANDS: { depth: number; color: [number, number, number]; label: string }[] = [
  { depth: 0, color: [214, 69, 65], label: '0（缺口）' },
  { depth: 1, color: [240, 173, 78], label: '1 層' },
  { depth: 2, color: [222, 217, 91], label: '2 層' },
  { depth: 3, color: [138, 196, 106], label: '3 層' },
  { depth: 4, color: [64, 145, 108], label: '4 層以上' },
];

const ALPHA = 150;
const MAX_BAND = DEPTH_BANDS.length - 1;

const DEG = Math.PI / 180;
const latToMercY = (lat: number) => (1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2;
const mercYToLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

export interface DepthOptions {
  sites: SiteState[];
  threat: Threat;
  altitudeM: number;
  mode: EstimateMode;
  aspect: Aspect;
  c2Mode: C2Mode;
}

/**
 * 產生縱深熱圖。回傳 null 代表在此高度沒有任何系統能作用。
 */
export function renderDepth(opts: DepthOptions): DepthRender | null {
  const t0 = performance.now();
  const { sites, threat, altitudeM, mode, aspect, c2Mode } = opts;
  if (sites.length === 0) return null;

  // 每個射手在此高度的運動學射程，以及每個感測器的最大可能偵測距離。
  // 先算好，逐點掃描時就能用平方距離快速跳過絕大多數不相干的陣地。
  const reach = new Map<string, number>();
  let anyReach = 0;
  for (const s of sites) {
    const kin = kinematicRange(s.system, altitudeM, mode, aspect);
    const r = kin?.rMaxM ?? 0;
    reach.set(s.id, r);
    anyReach = Math.max(anyReach, r);
  }
  if (anyReach <= 0) return null;

  // 涵蓋所有陣地射程聯集的外接框。
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const s of sites) {
    const r = reach.get(s.id) ?? 0;
    if (r <= 0) continue;
    const dLat = (r / 110_574) * 1.05;
    const dLon = (r / (111_412 * Math.cos(s.lat * DEG))) * 1.05;
    west = Math.min(west, s.lon - dLon);
    east = Math.max(east, s.lon + dLon);
    south = Math.min(south, s.lat - dLat);
    north = Math.max(north, s.lat + dLat);
  }
  if (!Number.isFinite(west)) return null;

  const yNorth = latToMercY(Math.min(85, north));
  const ySouth = latToMercY(Math.max(-85, south));

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const px = img.data;
  const histogram = new Array(DEPTH_BANDS.length).fill(0);

  // 每個射手的供軌感測器清單，先算好不要放進逐點迴圈。
  const sensorsOf = new Map<string, SiteState[]>();
  for (const s of sites) sensorsOf.set(s.id, sensorsFor(s, sites, c2Mode));
  const sharedSensors = c2Mode === 'shared' ? sites.filter((s) => s.system.sensor) : null;

  const target = { lon: 0, lat: 0, altitudeM };

  for (let row = 0; row < SIZE; row++) {
    const lat = mercYToLat(yNorth + ((ySouth - yNorth) * (row + 0.5)) / SIZE);
    target.lat = lat;

    for (let col = 0; col < SIZE; col++) {
      target.lon = west + ((east - west) * (col + 0.5)) / SIZE;
      const o = (row * SIZE + col) * 4;

      // 快篩：先看有沒有任何射手的運動學射程搆得到。
      let inUnion = false;
      for (const s of sites) {
        const r = reach.get(s.id) ?? 0;
        if (r <= 0) continue;
        const { dx, dy } = localOffsetM(s, target);
        if (dx * dx + dy * dy <= r * r) {
          inUnion = true;
          break;
        }
      }
      if (!inUnion) {
        px[o + 3] = 0;
        continue;
      }

      // 共享 C2 時全島用同一份感測器清單，偵獲判定每格只需算一次；
      // 各自為政時才必須逐射手重算。這個分支是熱圖能即時跑完的關鍵之一。
      let sharedDetected = true;
      if (sharedSensors) {
        sharedDetected = false;
        for (const sensor of sharedSensors) {
          if (detectionCheck(sensor, target, threat, mode) === null) {
            sharedDetected = true;
            break;
          }
        }
      }

      let depth = 0;
      if (sharedDetected) {
        for (const battery of sites) {
          if ((reach.get(battery.id) ?? 0) <= 0) continue;
          if (shooterCheck(battery, target, { threat, sensors: [], mode, aspect }) !== null) {
            continue;
          }
          if (sharedSensors) {
            depth++;
            continue;
          }
          const sensors = sensorsOf.get(battery.id) ?? [];
          for (const sensor of sensors) {
            if (detectionCheck(sensor, target, threat, mode) === null) {
              depth++;
              break;
            }
          }
        }
      }

      const band = Math.min(depth, MAX_BAND);
      histogram[band]++;
      const [r, g, b] = DEPTH_BANDS[band].color;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = ALPHA;
    }
  }

  ctx.putImageData(img, 0, 0);

  return {
    url: canvas.toDataURL('image/png'),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    histogram,
    computeMs: performance.now() - t0,
  };
}
