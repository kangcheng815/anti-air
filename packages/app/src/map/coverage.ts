/**
 * 把引擎算出的涵蓋結果轉成 GeoJSON。
 *
 * 這一層刻意很薄：所有物理都在 @anti-air/engine 裡，這裡只做座標搬運。
 * Phase 2 接上 MVA 場時，computeCoverage 回傳的 outerM 會從等值變成鋸齒狀，
 * 本檔一行都不用改。
 */

import {
  computeCoverage,
  destination,
  geodesicRing,
  type Aspect,
  type CoverageResult,
  type EstimateMode,
  type WeaponSystem,
} from '@anti-air/engine';
import { BY_ID, fillColor, strokeColor } from '../data/catalog';
import type { MvaEntry, Site } from '../state/store';

/** 無地形時涵蓋是正圓，2° 就夠。有地形時邊界呈鋸齒狀，需要更細的方位取樣。 */
const AZIMUTH_SMOOTH = 180;
const AZIMUTH_TERRAIN = 720;

export interface CoverageParams {
  altitudeM: number;
  estimateMode: EstimateMode;
  aspect: Aspect;
  /** 各陣地的 MVA 場。缺席或未就緒的陣地自動退回無地形模式。 */
  mvaBySite?: Record<string, MvaEntry>;
  terrainEnabled?: boolean;
}

function mvaOf(site: Site, params: CoverageParams) {
  if (params.terrainEnabled === false) return null;
  const entry = params.mvaBySite?.[site.id];
  return entry?.status === 'ready' ? (entry.field ?? null) : null;
}

export function coverageFor(site: Site, params: CoverageParams): CoverageResult | null {
  const system = BY_ID.get(site.systemId);
  if (!system) return null;
  const mva = mvaOf(site, params);
  return computeCoverage({
    system,
    altitudeM: params.altitudeM,
    siteGroundElevationM: site.groundElevationM,
    mode: params.estimateMode,
    aspect: params.aspect,
    azimuthCount: mva ? AZIMUTH_TERRAIN : AZIMUTH_SMOOTH,
    mva,
  });
}

function ringCoords(
  center: { lon: number; lat: number },
  radiiM: ArrayLike<number>,
): number[][] {
  return geodesicRing(center, radiiM).map((p) => [p.lon, p.lat]);
}

/** 半徑小於此值視為「該方位完全無涵蓋」。 */
const ZERO_M = 1;

function pointAt(
  site: Site,
  radiiM: ArrayLike<number>,
  index: number,
  count: number,
): number[] {
  const p = destination(site, (index * 360) / count, radiiM[index]);
  return [p.lon, p.lat];
}

/**
 * 找出所有「連續可涵蓋」的方位區段（含跨 0° 的接合）。
 */
function visibleRuns(outerM: ArrayLike<number>, count: number): number[][] {
  const visible = (i: number) => outerM[i] > ZERO_M;

  const runs: number[][] = [];
  let current: number[] | null = null;
  for (let i = 0; i < count; i++) {
    if (visible(i)) {
      current ??= [];
      current.push(i);
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);

  // 首尾都可見時，跨 0° 的兩段其實是同一段。
  if (runs.length > 1 && visible(0) && visible(count - 1)) {
    const first = runs.shift()!;
    runs[runs.length - 1] = runs[runs.length - 1].concat(first);
  }
  return runs;
}

/**
 * 陣地的涵蓋幾何。
 *
 * 地形把某些方位完全遮蔽時，**不能**把那些方位畫成「半徑 0 的頂點」——
 * 那會讓外環（以及最小射程的洞）有幾百個點塌在陣地中心，
 * 產生自相交的退化多邊形。MapLibre 的三角化會吐出大量重疊三角形，
 * 每個都疊一次 fill-opacity，畫面上就是一坨黑塊。
 *
 * 正確做法：被完全遮蔽的扇區是**不存在的區域**，不是半徑為零的區域。
 * 因此按連續可視方位切成數個扇形多邊形（MultiPolygon），
 * 每個扇形由外弧 + 反向內弧構成，必然是簡單多邊形。
 */
function coveragePolygon(
  site: Site,
  system: WeaponSystem,
  cov: CoverageResult,
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (cov.empty) return null;

  const n = cov.azimuthCount;
  const runs = visibleRuns(cov.outerM, n);
  if (runs.length === 0) return null;

  let geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;

  if (runs.length === 1 && runs[0].length === n) {
    // 全方位可涵蓋：正常的圓環，最小射程挖成洞。
    const rings: number[][][] = [ringCoords(site, cov.outerM)];
    if (Array.from(cov.innerM).some((r) => r > ZERO_M)) {
      // GeoJSON 規範要求洞的環繞方向與外環相反。
      rings.push(ringCoords(site, cov.innerM).reverse());
    }
    geometry = { type: 'Polygon', coordinates: rings };
  } else {
    const polygons: number[][][][] = [];
    for (const run of runs) {
      if (run.length < 2) continue; // 單一方位的細絲，畫不出面積

      const outer = run.map((i) => pointAt(site, cov.outerM, i, n));

      // 內弧反向接回去。整段內半徑都趨近 0 時，用單一中心點取代，
      // 否則會產生一串重複座標。
      const innerMax = Math.max(...run.map((i) => cov.innerM[i]));
      const inner =
        innerMax > ZERO_M
          ? [...run].reverse().map((i) => pointAt(site, cov.innerM, i, n))
          : [[site.lon, site.lat]];

      const ring = [...outer, ...inner];
      ring.push(ring[0]);
      polygons.push([ring]);
    }
    if (polygons.length === 0) return null;
    geometry = { type: 'MultiPolygon', coordinates: polygons };
  }

  return {
    type: 'Feature',
    id: site.id,
    geometry,
    properties: {
      siteId: site.id,
      systemId: system.id,
      name: site.name,
      fill: fillColor(system),
      stroke: strokeColor(system),
      zOrder: system.render?.z_order ?? 0,
      limitedBy: cov.limitedBy,
      status: site.status,
    },
  };
}

export function buildCoverageGeoJSON(
  sites: Site[],
  hidden: Set<string>,
  params: CoverageParams,
): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = [];

  for (const site of sites) {
    if (hidden.has(site.systemId) || site.status === 'down') continue;
    const system = BY_ID.get(site.systemId);
    if (!system) continue;
    const cov = coverageFor(site, params);
    if (!cov) continue;
    const f = coveragePolygon(site, system, cov);
    if (f) features.push(f);
  }

  // 大圈先畫、小圈後畫，避免高層的大面積蓋掉點防禦的小圈。
  features.sort((a, b) => Number(a.properties!.zOrder) - Number(b.properties!.zOrder));

  return { type: 'FeatureCollection', features };
}

export function buildSiteGeoJSON(sites: Site[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: sites.map((site) => {
      const system = BY_ID.get(site.systemId);
      return {
        type: 'Feature',
        id: site.id,
        geometry: { type: 'Point', coordinates: [site.lon, site.lat] },
        properties: {
          siteId: site.id,
          name: site.name,
          stroke: system ? strokeColor(system) : '#666',
          status: site.status,
        },
      };
    }),
  };
}
