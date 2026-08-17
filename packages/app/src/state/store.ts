/**
 * 應用狀態。
 *
 * Scenario（陣地 + 環境參數）就是這個 store 的可序列化子集 ——
 * 匯出存檔等於 JSON.stringify，匯入等於 set。存檔格式不另外設計一套。
 */

import { create } from 'zustand';
import type { Aspect, EstimateMode, MvaField } from '@anti-air/engine';
import { BY_ID, CATALOG } from '../data/catalog';
import { DEFAULT_THREAT_ID, THREAT_BY_ID } from '../data/threats';
import type { TerrainManifest } from '../terrain/mvaClient';

export type SiteStatus = 'ready' | 'reloading' | 'down';

export interface Site {
  id: string;
  systemId: string;
  name: string;
  lon: number;
  lat: number;
  /** 陣地地面高程 (m)。DEM 就緒時自動帶入，使用者可覆寫。 */
  groundElevationM: number;
  /** 高程來源。使用者手動改過就變成 manual，之後 DEM 不再覆蓋。 */
  elevationSource: 'dem' | 'manual';
  status: SiteStatus;
  /**
   * 本陣地待發彈量。null = 沿用系統目錄值。
   *
   * 系統目錄的 ready_rounds 是單一發射單元的量，一個連有幾具發射架屬於編制，
   * 不是武器性能 —— 那個數字只能由使用者在陣地層級給。
   */
  readyRoundsOverride: number | null;
}

export type LayerMode = 'coverage' | 'depth' | 'shadow';
export type C2Mode = 'shared' | 'independent';
export type LonLatTuple = [number, number];

/** 單一陣地的 MVA 場狀態。 */
export interface MvaEntry {
  /** 輸入指紋。與目前陣地狀態不符時代表結果已過期，要重算。 */
  key: string;
  status: 'pending' | 'ready' | 'error';
  field?: MvaField;
  demElevationM?: number;
  missingTiles?: number;
  computeMs?: number;
  error?: string;
}

/**
 * 威脅航跡（Phase 4）。
 *
 * 高度只存「進入」與「終端」兩個值，逐航點的高度由沿線距離比例內插而得。
 * 這樣使用者在航跡中間插一個轉折點時，下降剖面不會被打亂 ——
 * 若改成逐航點各存一個高度，加點就會變成一件需要重新調整每一段的事。
 */
export interface ThreatTrack {
  id: string;
  name: string;
  /** 對應 data/threats.json。決定 RCS，進而決定整條航跡的被偵獲距離。 */
  threatId: string;
  path: LonLatTuple[];
  speedMps: number;
  altStartM: number;
  altEndM: number;
  /** 同一條航跡上的架次數（波次規模）。 */
  count: number;
  /** 相鄰架次的發起間隔 (s)。 */
  spacingS: number;
  startTimeS: number;
}

/** 存檔格式。版本號用於未來的遷移。v2 起含航跡。 */
export interface Scenario {
  version: 1 | 2;
  name: string;
  sites: Site[];
  altitudeM: number;
  estimateMode: EstimateMode;
  aspect: Aspect;
  tracks?: ThreatTrack[];
}

interface AppState {
  sites: Site[];
  selectedSiteId: string | null;
  /** 已選定、等待點擊地圖放置的系統 id。null = 一般選取模式。 */
  armedSystemId: string | null;
  hiddenSystemIds: Set<string>;

  altitudeM: number;
  estimateMode: EstimateMode;
  aspect: Aspect;
  /**
   * 主圖層模式，互斥。
   * DESIGN.md §6.1：多層半透明疊圖會糊成一團，一次只看一種。
   */
  layerMode: LayerMode;
  setLayerMode: (m: LayerMode) => void;

  /** 威脅剖面。決定 RCS，進而決定所有感測器的偵測距離。 */
  threatId: string;
  setThreatId: (id: string) => void;

  /** C2 配置。shared = 全島單一資料鏈；independent = 各陣地只用自己的感測器。 */
  c2Mode: C2Mode;
  setC2Mode: (m: C2Mode) => void;

  /** 垂直剖面的兩個端點。null = 未繪製。 */
  sectionLine: [LonLatTuple, LonLatTuple] | null;
  sectionDrawing: boolean;
  startSectionDraw: () => void;
  addSectionPoint: (lon: number, lat: number) => void;
  clearSection: () => void;

  // ---- Phase 4：時間 ----
  tracks: ThreatTrack[];
  selectedTrackId: string | null;
  /** 正在地圖上畫航跡。畫的過程中點擊一律是取點。 */
  trackDrawing: boolean;
  /** 時間軸面板是否開啟。與垂直剖面互斥（兩者都佔用地圖下方同一塊空間）。 */
  timelineOpen: boolean;
  /** 時間游標 (s)。地圖上的目標位置與飛彈連線都依它繪製。 */
  simTimeS: number;
  /** 每次接戰的齊射彈數。明確的接戰準則假設，不是物理常數。 */
  salvoSize: number;
  /** 單一射手對同一目標的接戰次數上限。 */
  maxEngagements: number;

  startTrackDraw: () => void;
  addTrackPoint: (lon: number, lat: number) => void;
  finishTrackDraw: () => void;
  selectTrack: (id: string | null) => void;
  updateTrack: (id: string, patch: Partial<ThreatTrack>) => void;
  removeTrack: (id: string) => void;
  setTimelineOpen: (v: boolean) => void;
  setSimTime: (s: number) => void;
  setSalvoSize: (n: number) => void;
  setMaxEngagements: (n: number) => void;

  basemapId: string;

  /** null = 尚未檢查；否則為 manifest 或「已檢查但沒有資料」。 */
  terrainManifest: TerrainManifest | null;
  terrainChecked: boolean;
  /** 使用者可關掉地形，用來直接對比「有沒有算地形」的差別。 */
  terrainEnabled: boolean;
  mva: Record<string, MvaEntry>;

  setTerrainManifest: (m: TerrainManifest | null) => void;
  setTerrainEnabled: (v: boolean) => void;
  setMvaEntry: (siteId: string, entry: MvaEntry) => void;

  arm: (systemId: string | null) => void;
  placeSite: (lon: number, lat: number) => void;
  selectSite: (id: string | null) => void;
  updateSite: (id: string, patch: Partial<Site>) => void;
  removeSite: (id: string) => void;
  toggleSystemVisible: (systemId: string) => void;

  setAltitude: (m: number) => void;
  setEstimateMode: (m: EstimateMode) => void;
  setAspect: (a: Aspect) => void;
  setBasemap: (id: string) => void;

  exportScenario: () => Scenario;
  importScenario: (s: Scenario) => void;
  clearAll: () => void;
}

let counter = 0;
let trackCounter = 0;
function nextName(systemId: string): string {
  const sys = BY_ID.get(systemId);
  counter += 1;
  return `${sys?.name_zh ?? systemId} #${counter}`;
}

export const useStore = create<AppState>((set, get) => ({
  sites: [],
  selectedSiteId: null,
  armedSystemId: CATALOG[0]?.id ?? null,
  hiddenSystemIds: new Set(),

  altitudeM: 5000,
  estimateMode: 'nominal',
  aspect: 'head_on',
  layerMode: 'coverage',
  setLayerMode: (m) => set({ layerMode: m }),

  threatId: DEFAULT_THREAT_ID,
  setThreatId: (id) => set({ threatId: id }),

  c2Mode: 'shared',
  setC2Mode: (m) => set({ c2Mode: m }),

  sectionLine: null,
  sectionDrawing: false,
  startSectionDraw: () =>
    set({
      sectionDrawing: true,
      sectionLine: null,
      armedSystemId: null,
      trackDrawing: false,
      timelineOpen: false,
    }),
  addSectionPoint: (lon, lat) =>
    set((s) => {
      if (!s.sectionDrawing) return {};
      const first = s.sectionLine?.[0];
      if (!first) return { sectionLine: [[lon, lat], [lon, lat]] };
      return { sectionLine: [first, [lon, lat]], sectionDrawing: false };
    }),
  clearSection: () => set({ sectionLine: null, sectionDrawing: false }),

  // ---- Phase 4 ----
  tracks: [],
  selectedTrackId: null,
  trackDrawing: false,
  timelineOpen: false,
  simTimeS: 0,
  salvoSize: 1,
  maxEngagements: 2,

  startTrackDraw: () =>
    set((s) => {
      const threat = THREAT_BY_ID.get(s.threatId);
      trackCounter += 1;
      const track: ThreatTrack = {
        id: crypto.randomUUID(),
        name: `${threat?.name_zh ?? '威脅'} 航跡 ${trackCounter}`,
        threatId: s.threatId,
        path: [],
        speedMps: Math.round(threat?.speed_mps.nominal ?? 250),
        // 預設高度取威脅的典型高度：巡弋飛彈掠海、彈道飛彈在中段，
        // 各自差好幾個數量級，用同一個預設值等於每次都要先改。
        altStartM: threat?.typical_altitude_m ?? 1000,
        altEndM: threat?.typical_altitude_m ?? 1000,
        count: 1,
        spacingS: 15,
        startTimeS: 0,
      };
      return {
        tracks: [...s.tracks, track],
        selectedTrackId: track.id,
        selectedSiteId: null,
        trackDrawing: true,
        armedSystemId: null,
        sectionDrawing: false,
        timelineOpen: false,
      };
    }),

  addTrackPoint: (lon, lat) =>
    set((s) => {
      if (!s.trackDrawing || !s.selectedTrackId) return {};
      return {
        tracks: s.tracks.map((t) =>
          t.id === s.selectedTrackId ? { ...t, path: [...t.path, [lon, lat]] } : t,
        ),
      };
    }),

  // 少於兩點的航跡不是「短航跡」，是無效輸入 —— 直接丟掉，不要留一個
  // 永遠算不出結果的空殼在清單裡。
  finishTrackDraw: () =>
    set((s) => {
      const current = s.tracks.find((t) => t.id === s.selectedTrackId);
      if (!current) return { trackDrawing: false };

      // 雙擊會先送出兩次 click，最後一點因此被加了兩次。
      // 重複點會產生零長度航段（無害但難看），在收尾時去掉。
      let path = current.path;
      if (path.length >= 2) {
        const [aLon, aLat] = path[path.length - 2];
        const [bLon, bLat] = path[path.length - 1];
        if (Math.abs(aLon - bLon) < 1e-6 && Math.abs(aLat - bLat) < 1e-6) path = path.slice(0, -1);
      }

      if (path.length < 2) {
        return {
          tracks: s.tracks.filter((t) => t.id !== current.id),
          selectedTrackId: null,
          trackDrawing: false,
        };
      }
      return {
        tracks: s.tracks.map((t) => (t.id === current.id ? { ...t, path } : t)),
        trackDrawing: false,
        timelineOpen: true,
        sectionLine: null,
        sectionDrawing: false,
      };
    }),

  // 陣地與航跡共用右側詳情面板，選一個就必須放掉另一個。
  selectTrack: (id) => set(id ? { selectedTrackId: id, selectedSiteId: null } : { selectedTrackId: null }),

  updateTrack: (id, patch) =>
    set((s) => ({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  removeTrack: (id) =>
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
    })),

  setTimelineOpen: (v) =>
    set(v ? { timelineOpen: true, sectionLine: null, sectionDrawing: false } : { timelineOpen: false }),
  setSimTime: (s) => set({ simTimeS: s }),
  setSalvoSize: (n) => set({ salvoSize: Math.max(1, Math.round(n)) }),
  setMaxEngagements: (n) => set({ maxEngagements: Math.max(1, Math.round(n)) }),

  basemapId: 'positron',

  terrainManifest: null,
  terrainChecked: false,
  terrainEnabled: true,
  mva: {},

  setTerrainManifest: (m) => set({ terrainManifest: m, terrainChecked: true }),
  setTerrainEnabled: (v) => set({ terrainEnabled: v }),
  setMvaEntry: (siteId, entry) => set((s) => ({ mva: { ...s.mva, [siteId]: entry } })),

  arm: (systemId) => set({ armedSystemId: systemId }),

  placeSite: (lon, lat) => {
    const systemId = get().armedSystemId;
    if (!systemId) return;
    const site: Site = {
      id: crypto.randomUUID(),
      systemId,
      name: nextName(systemId),
      lon,
      lat,
      groundElevationM: 0,
      elevationSource: 'dem',
      status: 'ready',
      readyRoundsOverride: null,
    };
    set((s) => ({ sites: [...s.sites, site], selectedSiteId: site.id }));
  },

  selectSite: (id) => set(id ? { selectedSiteId: id, selectedTrackId: null } : { selectedSiteId: null }),

  updateSite: (id, patch) =>
    set((s) => ({ sites: s.sites.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),

  removeSite: (id) =>
    set((s) => {
      const { [id]: _removed, ...restMva } = s.mva;
      return {
        sites: s.sites.filter((x) => x.id !== id),
        mva: restMva,
        selectedSiteId: s.selectedSiteId === id ? null : s.selectedSiteId,
      };
    }),

  toggleSystemVisible: (systemId) =>
    set((s) => {
      const next = new Set(s.hiddenSystemIds);
      if (next.has(systemId)) next.delete(systemId);
      else next.add(systemId);
      return { hiddenSystemIds: next };
    }),

  setAltitude: (m) => set({ altitudeM: m }),
  setEstimateMode: (m) => set({ estimateMode: m }),
  setAspect: (a) => set({ aspect: a }),
  setBasemap: (id) => set({ basemapId: id }),

  exportScenario: () => {
    const s = get();
    return {
      version: 2,
      name: '未命名想定',
      sites: s.sites,
      altitudeM: s.altitudeM,
      estimateMode: s.estimateMode,
      aspect: s.aspect,
      tracks: s.tracks,
    };
  },

  importScenario: (scenario) =>
    set({
      // 舊版想定檔沒有 elevationSource，補成 manual：既然存檔裡有高程值，
      // 就不該被 DEM 悄悄改掉。
      sites: (scenario.sites ?? []).map((s) => ({
        ...s,
        elevationSource: s.elevationSource ?? ('manual' as const),
        readyRoundsOverride: s.readyRoundsOverride ?? null,
      })),
      // v1 存檔沒有航跡欄位，讀進來就是沒有航跡 —— 不是錯誤。
      tracks: scenario.tracks ?? [],
      altitudeM: scenario.altitudeM ?? 5000,
      estimateMode: scenario.estimateMode ?? 'nominal',
      aspect: scenario.aspect ?? 'head_on',
      selectedSiteId: null,
      selectedTrackId: null,
      trackDrawing: false,
      simTimeS: 0,
      mva: {},
    }),

  clearAll: () =>
    set({
      sites: [],
      tracks: [],
      selectedSiteId: null,
      selectedTrackId: null,
      trackDrawing: false,
      simTimeS: 0,
      mva: {},
    }),
}));
