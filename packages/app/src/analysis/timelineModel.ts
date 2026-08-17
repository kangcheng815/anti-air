/**
 * store 的航跡 → 引擎的 TimelineTrack，以及跑模擬的單一入口。
 *
 * 這一層存在的理由跟 siteStates.ts 一樣：轉換只做一次，
 * 地圖圖層、時間軸面板、統計都吃同一份結果，不會各算各的而彼此不一致。
 */

import {
  contactPositionAt,
  expandContacts,
  simulate,
  trackGeometry,
  type SiteState,
  type TimelineResult,
  type TimelineTrack,
  type TrackWaypoint,
  type Aspect,
  type EstimateMode,
} from '@anti-air/engine';
import { useMemo } from 'react';
import { THREAT_BY_ID } from '../data/threats';
import { useStore, type C2Mode, type MvaEntry, type Site, type ThreatTrack } from '../state/store';
import { sensorsFor, toSiteStates } from './siteStates';

/**
 * 把「進入高度 / 終端高度」展開成逐航點高度。
 *
 * 依**沿線累積距離**的比例內插，而不是航點序號的比例：
 * 一條 200 km 的長段接一條 10 km 的短段時，用序號會讓高度在短段上暴跌。
 */
export function toEngineTrack(track: ThreatTrack): TimelineTrack | null {
  const threat = THREAT_BY_ID.get(track.threatId);
  if (!threat || track.path.length < 2 || track.speedMps <= 0) return null;

  const flat: TrackWaypoint[] = track.path.map(([lon, lat]) => ({
    lon,
    lat,
    altitudeM: track.altStartM,
  }));

  const base = {
    id: track.id,
    waypoints: flat,
    speedMps: track.speedMps,
    count: Math.max(1, Math.round(track.count)),
    spacingS: Math.max(0, track.spacingS),
    startTimeS: Math.max(0, track.startTimeS),
  };
  const geom = trackGeometry(base);
  if (!(geom.totalM > 0)) return null;

  const waypoints = flat.map((wp, i) => ({
    ...wp,
    altitudeM:
      track.altStartM + (track.altEndM - track.altStartM) * (geom.cumM[i] / geom.totalM),
  }));

  return { ...base, waypoints, threat };
}

export interface RunTimelineOptions {
  sites: Site[];
  mva: Record<string, MvaEntry>;
  terrainEnabled: boolean;
  tracks: ThreatTrack[];
  estimateMode: EstimateMode;
  aspect: Aspect;
  c2Mode: C2Mode;
  salvoSize: number;
  maxEngagements: number;
}

export interface TimelineRun {
  result: TimelineResult;
  engineTracks: TimelineTrack[];
  /** 只有 status 為 down 以外、且有系統定義的陣地會進入模擬。 */
  states: SiteState[];
}

/** 回傳 null 代表沒有可模擬的內容（沒有航跡或沒有陣地）。 */
export function runTimeline(opts: RunTimelineOptions): TimelineRun | null {
  const engineTracks = opts.tracks
    .map(toEngineTrack)
    .filter((t): t is TimelineTrack => t !== null);
  if (engineTracks.length === 0) return null;

  const states = toSiteStates(opts.sites, opts.mva, opts.terrainEnabled);
  if (states.length === 0) return null;

  const result = simulate({
    batteries: states,
    sensorsOf: (b) => sensorsFor(b, states, opts.c2Mode),
    tracks: engineTracks,
    mode: opts.estimateMode,
    aspect: opts.aspect,
    salvoSize: opts.salvoSize,
    maxEngagementsPerContact: opts.maxEngagements,
  });

  return { result, engineTracks, states };
}

/**
 * 共用的模擬結果。
 *
 * 地圖與時間軸面板需要的是**同一次**模擬：兩邊各跑一次不只是浪費
 * （30 個接觸實測約 200 ms，跑兩次就是 400 ms），更糟的是兩張圖有可能
 * 因為 React 更新時序不同而短暫顯示不一致的結果。
 *
 * 用單槽快取而不是 Context：輸入全部來自 store，物件識別穩定，
 * 兩個元件在同一輪 render 中傳進來的就是同一組參考，第二次呼叫必定命中。
 */
let cache: { key: unknown[]; value: TimelineRun | null } | null = null;

export function useTimelineRun(): TimelineRun | null {
  const timelineOpen = useStore((s) => s.timelineOpen);
  const sites = useStore((s) => s.sites);
  const mva = useStore((s) => s.mva);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const tracks = useStore((s) => s.tracks);
  const estimateMode = useStore((s) => s.estimateMode);
  const aspect = useStore((s) => s.aspect);
  const c2Mode = useStore((s) => s.c2Mode);
  const salvoSize = useStore((s) => s.salvoSize);
  const maxEngagements = useStore((s) => s.maxEngagements);

  return useMemo(() => {
    if (!timelineOpen) return null;
    const key = [
      sites,
      mva,
      terrainEnabled,
      tracks,
      estimateMode,
      aspect,
      c2Mode,
      salvoSize,
      maxEngagements,
    ];
    if (cache && cache.key.length === key.length && cache.key.every((v, i) => v === key[i])) {
      return cache.value;
    }
    const value = runTimeline({
      sites,
      mva,
      terrainEnabled,
      tracks,
      estimateMode,
      aspect,
      c2Mode,
      salvoSize,
      maxEngagements,
    });
    cache = { key, value };
    return value;
  }, [
    timelineOpen,
    sites,
    mva,
    terrainEnabled,
    tracks,
    estimateMode,
    aspect,
    c2Mode,
    salvoSize,
    maxEngagements,
  ]);
}

// ------------------------------------------------------------- 時間切片
//
// 地圖上要畫的是「T+t 這一刻」的畫面：目標在哪、哪些飛彈在飛。
// 模擬結果只記錄事件，這裡把事件還原成位置。

export interface ContactSnapshot {
  contactId: string;
  trackId: string;
  index: number;
  lon: number;
  lat: number;
  altitudeM: number;
  /** 這個接觸在整場模擬中是否曾被射擊。 */
  engaged: boolean;
  leakReason: string | null;
}

export interface MissileSnapshot {
  siteId: string;
  contactId: string;
  /** 發射點（射手位置）。 */
  from: [number, number];
  /** 目前的彈體位置。 */
  now: [number, number];
  /** 攔截點。 */
  to: [number, number];
}

/** 指定時刻仍在航線上的所有接觸。 */
export function snapshotContacts(run: TimelineRun, timeS: number): ContactSnapshot[] {
  const outcomeById = new Map(run.result.contacts.map((c) => [c.contactId, c]));
  const out: ContactSnapshot[] = [];

  for (const track of run.engineTracks) {
    const geom = trackGeometry(track);
    for (const contact of expandContacts(track, geom)) {
      const pos = contactPositionAt(track, geom, contact, timeS);
      if (!pos) continue;
      const outcome = outcomeById.get(contact.id);
      out.push({
        contactId: contact.id,
        trackId: track.id,
        index: contact.index,
        lon: pos.lon,
        lat: pos.lat,
        altitudeM: pos.altitudeM,
        engaged: (outcome?.shots.length ?? 0) > 0,
        leakReason: outcome?.leakReason ?? null,
      });
    }
  }
  return out;
}

/**
 * 指定時刻在空中的飛彈。
 *
 * 彈體位置在發射點與攔截點之間線性內插 —— 這正是模擬所用的模型
 * （直線、等速），畫面上不應該畫出比模型更花俏的彈道，
 * 那會讓人以為工具算了它其實沒算的東西。
 */
export function snapshotMissiles(run: TimelineRun, timeS: number): MissileSnapshot[] {
  const siteById = new Map(run.states.map((s) => [s.id, s]));
  const out: MissileSnapshot[] = [];

  for (const shot of run.result.shots) {
    if (timeS < shot.fireTimeS || timeS > shot.interceptTimeS) continue;
    const site = siteById.get(shot.siteId);
    if (!site) continue;
    const span = shot.interceptTimeS - shot.fireTimeS;
    const f = span > 0 ? (timeS - shot.fireTimeS) / span : 1;
    out.push({
      siteId: shot.siteId,
      contactId: shot.contactId,
      from: [site.lon, site.lat],
      now: [
        site.lon + (shot.interceptLon - site.lon) * f,
        site.lat + (shot.interceptLat - site.lat) * f,
      ],
      to: [shot.interceptLon, shot.interceptLat],
    });
  }
  return out;
}

export const LEAK_LABEL: Record<string, string> = {
  'never-detected': '從未偵獲',
  'channels-saturated': '通道飽和',
  'magazine-empty': '待發彈耗盡',
  'too-late': '反應不及',
  'never-in-envelope': '不在接戰包絡內',
};

export const LEAK_HINT: Record<string, string> = {
  'never-detected': '沒有任何感測器抓到它。加射手沒有用，要加的是感測器或前推部署。',
  'channels-saturated': '打得到也看得到，只是同時接戰的目標太多。這是飽和攻擊的直接證據。',
  'magazine-empty': '待發彈打完了。再裝填時間本工具未模擬，實務上這段是真空期。',
  'too-late': '從偵獲到抵達的時間短於最短反應時間。彈道沒問題，是預警時間不夠。',
  'never-in-envelope': '偵獲得到，但沒有任何時刻存在合法攔截點 —— 射程、地形或高度限制。',
};
