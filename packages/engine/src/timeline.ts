/**
 * 接戰時間軸 —— Phase 4 的核心。
 *
 * ## 這裡刻意不算什麼：擊殺機率
 *
 * 最容易被期待的輸出是「打不打得下來」。本模組**不產生**這個數字，
 * 因為它需要 Pk（單發擊殺率），而 Pk 是各國最保護的參數之一，
 * 公開來源全是猜的，而且對目標型別、接戰幾何、電子作戰環境極度敏感。
 * 用一個捏造的 Pk 乘上去，只會把「猜測」包裝成「戰損評估」。
 *
 * 本模組輸出的是**射擊機會**：在目標抵達其目標區之前，防空網總共能發射幾次、
 * 在哪個距離發射、哪些目標一次都沒被打到、以及沒打到的原因是哪一個環節。
 * 這些全部由幾何與時序決定，用的都是已經在 data/ 裡、標好不確定度的參數。
 *
 * 飽和分析在這個框架下依然完整成立：三十個目標同時進入、全網總通道數十二，
 * 有十八個一次都輪不到 —— 這個結論不需要知道 Pk。
 *
 * ## 明確列出的假設
 *
 * 1. **一有機會就打**（fire-as-soon-as-legal）。這會最大化射擊次數，
 *    因此結果是射擊機會的**上界**，對防守方樂觀。
 * 2. **飛彈直線等速**飛向攔截點，速度取 `avg_missile_speed_mps`。
 *    不模擬助推/滑翔段、不模擬前置導引的實際彈道。
 * 3. **攔截點必須合法**：在攔截時刻，該點要通過完整接戰條件鏈
 *    （運動學包絡、最小射程、扇區、導引視線），而且 C2 群組在該時刻仍維持接觸。
 *    後者是中途指令的前提 —— 目標飛進地形陰影，導引就斷了。
 * 4. **射擊優先序**：同一時刻多個目標競爭有限通道時，先打距離其目標區
 *    剩餘時間最短的。這是一個明確的接戰準則假設，不是物理。
 * 5. **每個射手對同一目標的接戰次數有上限**（預設 2，即射—評—再射）。
 *    不設上限的話，單一射手會對同一個目標無限重複開火，飽和分析就失去意義。
 */

import { bearingDistance } from './geodesy.js';
import { resolve, type EstimateMode } from './estimate.js';
import { peakRangeM } from './envelope.js';
import { detectedByAny, shooterCheck, type SiteState } from './engagement.js';
import type { Threat } from './threat.js';
import type { Aspect } from './system.js';
import {
  contactPositionAt,
  expandContacts,
  trackGeometry,
  type Contact,
  type Track,
  type TrackGeometry,
  type TrackWaypoint,
} from './track.js';

export interface TimelineTrack extends Track {
  threat: Threat;
}

export interface Shot {
  siteId: string;
  contactId: string;
  trackId: string;
  fireTimeS: number;
  /** 發射瞬間射手到目標的距離 (m)。 */
  fireRangeM: number;
  interceptTimeS: number;
  /** 射手到攔截點的距離 (m) ＝ 飛彈飛行距離。 */
  interceptRangeM: number;
  interceptLon: number;
  interceptLat: number;
  interceptAltM: number;
  /** 本次接戰消耗的彈數（砲為發數）。 */
  rounds: number;
  /** 通道被佔用到何時（含評估時間）。 */
  channelFreeS: number;
}

export type LeakReason =
  /** 從頭到尾沒有任何感測器偵獲。 */
  | 'never-detected'
  /** 通道全滿，有機會但沒有人空著。這是飽和攻擊的直接證據。 */
  | 'channels-saturated'
  /** 待發彈打完了。 */
  | 'magazine-empty'
  /** 偵獲到抵達之間的時間短於最短反應時間。 */
  | 'too-late'
  /** 偵獲得到，但沒有任何時刻存在合法的攔截點（射程、地形、高度限制）。 */
  | 'never-in-envelope';

export interface ContactOutcome {
  contactId: string;
  trackId: string;
  index: number;
  entryTimeS: number;
  arrivalTimeS: number;
  /** 最早被任一 C2 群組偵獲的時間。null = 從未偵獲。 */
  firstDetectS: number | null;
  shots: Shot[];
  /** shots 為空時的原因；有射擊機會時為 null。 */
  leakReason: LeakReason | null;
}

export interface SiteLoad {
  siteId: string;
  channels: number;
  readyRounds: number;
  roundsFired: number;
  shotCount: number;
  /** 同時佔用通道數的尖峰。 */
  peakChannelsUsed: number;
  /** 通道全滿的累計時間 (s)。 */
  saturatedS: number;
  /** 因通道全滿而錯失的射擊機會次數。 */
  deniedByChannel: number;
  /** 因待發彈不足而錯失的射擊機會次數。 */
  deniedByMagazine: number;
}

export interface TimelineSummary {
  contactCount: number;
  /** 至少被射擊一次的接觸數。 */
  engagedCount: number;
  leakCount: number;
  totalShots: number;
  /** 每個「被接戰的接觸」平均獲得幾次射擊機會。 */
  meanShotsPerEngaged: number;
}

export interface SkippedBattery {
  siteId: string;
  reason: 'no-missile-speed';
}

export interface TimelineResult {
  contacts: ContactOutcome[];
  loads: SiteLoad[];
  shots: Shot[];
  summary: TimelineSummary;
  /** 模擬到第幾秒。 */
  horizonS: number;
  stepS: number;
  /** 因缺少必要參數而未納入模擬的射手。據實列出，不要靜默忽略。 */
  skipped: SkippedBattery[];
  computeMs: number;
}

export interface TimelineOptions {
  batteries: SiteState[];
  /** 每個射手可用的感測器。呼叫端依 C2 模式決定，本模組不假設 C2 結構。 */
  sensorsOf: (battery: SiteState) => SiteState[];
  tracks: TimelineTrack[];
  mode?: EstimateMode;
  aspect?: Aspect;
  /** 每次接戰的齊射彈數。1 = 射後評估，2 = 每目標兩發。 */
  salvoSize?: number;
  /** 單一射手對同一目標的接戰次數上限。 */
  maxEngagementsPerContact?: number;
  stepS?: number;
  maxHorizonS?: number;
}

const DEFAULT_STEP_S = 1;
const DEFAULT_MAX_HORIZON_S = 3600;
const DEFAULT_SALVO = 1;
const DEFAULT_MAX_ENGAGEMENTS = 2;

/** 粗篩用的射程放大係數：迎面而來的目標會在飛彈飛行期間再靠近一段。 */
const REACH_MARGIN = 1.6;

interface RtContact extends Contact {
  /** 每個感測器群組首次偵獲的時間；undefined = 尚未偵獲。 */
  detectedAt: (number | undefined)[];
  /** 當下是否仍維持接觸（逐步更新）。 */
  detectedNow: boolean[];
  shots: Shot[];
  everInReach: boolean;
  blockedByChannel: boolean;
  blockedByMagazine: boolean;
}

interface RtBattery {
  site: SiteState;
  groupIndex: number;
  reactionS: number;
  assessS: number;
  channels: number;
  missileMps: number;
  roundsPerEngagement: number;
  maxReachM: number;
  roundsLeft: number;
  /** 每個通道的釋放時間。 */
  busyUntilS: number[];
  /** 本射手對某目標的接戰結束時間。 */
  engagedUntilS: Map<string, number>;
  engagementCount: Map<string, number>;
  load: SiteLoad;
}

export function simulate(opts: TimelineOptions): TimelineResult {
  const t0 = performance.now();
  const mode = opts.mode ?? 'nominal';
  const aspect = opts.aspect ?? 'head_on';
  const stepS = Math.max(0.05, opts.stepS ?? DEFAULT_STEP_S);
  const salvo = Math.max(1, Math.round(opts.salvoSize ?? DEFAULT_SALVO));
  const maxEngagements = Math.max(
    1,
    Math.round(opts.maxEngagementsPerContact ?? DEFAULT_MAX_ENGAGEMENTS),
  );

  // ---------------------------------------------------------- 展開航跡
  const geoms = new Map<string, TrackGeometry>();
  const trackById = new Map<string, TimelineTrack>();
  const contacts: RtContact[] = [];

  for (const track of opts.tracks) {
    if (track.waypoints.length < 2 || track.speedMps <= 0) continue;
    const geom = trackGeometry(track);
    if (!(geom.totalM > 0) || !Number.isFinite(geom.durationS)) continue;
    geoms.set(track.id, geom);
    trackById.set(track.id, track);
    for (const c of expandContacts(track, geom)) {
      contacts.push({
        ...c,
        detectedAt: [],
        detectedNow: [],
        shots: [],
        everInReach: false,
        blockedByChannel: false,
        blockedByMagazine: false,
      });
    }
  }

  // ---------------------------------------------------------- 感測器群組
  //
  // 「全島共享」時每個射手拿到的是同一份感測器清單。偵獲判定是逐時步、
  // 逐接觸的熱點，去重後從 O(射手數) 降到 O(相異群組數) —— 共享模式下就是 1。
  const groups: SiteState[][] = [];
  const groupKeyToIndex = new Map<string, number>();
  const groupIndexOfBattery = new Map<string, number>();

  for (const b of opts.batteries) {
    const sensors = opts.sensorsOf(b);
    const key = sensors
      .map((s) => s.id)
      .sort()
      .join('|');
    let gi = groupKeyToIndex.get(key);
    if (gi === undefined) {
      gi = groups.length;
      groups.push(sensors);
      groupKeyToIndex.set(key, gi);
    }
    groupIndexOfBattery.set(b.id, gi);
  }

  // ---------------------------------------------------------- 射手
  const rts: RtBattery[] = [];
  const skipped: SkippedBattery[] = [];

  for (const b of opts.batteries) {
    const e = b.system.engagement;
    const missileMps = e.avg_missile_speed_mps
      ? resolve(e.avg_missile_speed_mps, mode, 'higher')
      : 0;
    if (!(missileMps > 0)) {
      skipped.push({ siteId: b.id, reason: 'no-missile-speed' });
      continue;
    }

    const channels = Math.max(1, Math.round(resolve(e.channels, mode, 'higher')));
    const readyRounds =
      b.readyRoundsOverride !== undefined
        ? Math.max(0, Math.round(b.readyRoundsOverride))
        : e.ready_rounds
          ? Math.max(0, Math.round(resolve(e.ready_rounds, mode, 'higher')))
          : Infinity;
    const perEngagement = e.rounds_per_engagement
      ? Math.max(1, Math.round(resolve(e.rounds_per_engagement, mode, 'lower')))
      : 1;

    rts.push({
      site: b,
      groupIndex: groupIndexOfBattery.get(b.id) ?? 0,
      // 反應時間與評估時間都是「越小對防守方越有利」，極性與射程相反。
      reactionS: resolve(e.reaction_s, mode, 'lower'),
      assessS: e.assess_s ? resolve(e.assess_s, mode, 'lower') : 0,
      channels,
      missileMps,
      roundsPerEngagement: perEngagement,
      maxReachM: peakRangeM(b.system, mode),
      roundsLeft: readyRounds,
      busyUntilS: new Array(channels).fill(-Infinity),
      engagedUntilS: new Map(),
      engagementCount: new Map(),
      load: {
        siteId: b.id,
        channels,
        readyRounds,
        roundsFired: 0,
        shotCount: 0,
        peakChannelsUsed: 0,
        saturatedS: 0,
        deniedByChannel: 0,
        deniedByMagazine: 0,
      },
    });
  }

  for (const c of contacts) {
    c.detectedAt = new Array(groups.length).fill(undefined);
    c.detectedNow = new Array(groups.length).fill(false);
  }

  const shots: Shot[] = [];

  if (contacts.length === 0 || rts.length === 0) {
    return finish(contacts, rts, shots, 0, stepS, skipped, t0, Infinity);
  }

  const horizonS = Math.min(
    opts.maxHorizonS ?? DEFAULT_MAX_HORIZON_S,
    Math.max(...contacts.map((c) => c.arrivalTimeS)),
  );
  const minReactionS = Math.min(...rts.map((r) => r.reactionS));

  // ---------------------------------------------------------- 主迴圈
  const live: { c: RtContact; pos: TrackWaypoint }[] = [];

  for (let t = 0; t <= horizonS + 1e-9; t += stepS) {
    live.length = 0;
    for (const c of contacts) {
      const track = trackById.get(c.trackId)!;
      const pos = contactPositionAt(track, geoms.get(c.trackId)!, c, t);
      if (pos) live.push({ c, pos });
    }
    if (live.length === 0) continue;

    // 1. 偵獲狀態
    for (const { c, pos } of live) {
      const threat = trackById.get(c.trackId)!.threat;
      for (let gi = 0; gi < groups.length; gi++) {
        const ok = detectedByAny(groups[gi], pos, threat, mode);
        c.detectedNow[gi] = ok;
        if (ok && c.detectedAt[gi] === undefined) c.detectedAt[gi] = t;
      }
    }

    // 2. 通道佔用統計
    for (const rt of rts) {
      let used = 0;
      for (const until of rt.busyUntilS) if (until > t) used++;
      if (used > rt.load.peakChannelsUsed) rt.load.peakChannelsUsed = used;
      if (used >= rt.channels) rt.load.saturatedS += stepS;
    }

    // 3. 開火。急迫者優先 —— 距離其目標區剩餘時間最短的先打。
    live.sort((a, b) => a.c.arrivalTimeS - b.c.arrivalTimeS);

    for (const { c, pos } of live) {
      const track = trackById.get(c.trackId)!;
      const geom = geoms.get(c.trackId)!;

      for (const rt of rts) {
        const gi = rt.groupIndex;
        const firstDet = c.detectedAt[gi];
        if (firstDet === undefined) continue; // 這個群組還沒抓到

        // 「進入過射程」必須在反應時間閘門**之前**記錄。
        // 否則被反應時間擋掉的目標會被誤判成「本來就不在包絡內」，
        // 而這兩者的意義完全不同：一個要換飛彈，一個要改警戒程序。
        const { distanceM } = bearingDistance(rt.site, pos);
        if (distanceM > rt.maxReachM * REACH_MARGIN) continue;
        c.everInReach = true;

        if (!c.detectedNow[gi]) continue; // 接觸中斷，不能發射
        if (t < firstDet + rt.reactionS) continue; // 反應時間未到

        const engagedUntil = rt.engagedUntilS.get(c.id);
        if (engagedUntil !== undefined && engagedUntil > t) continue; // 正在接戰中
        if ((rt.engagementCount.get(c.id) ?? 0) >= maxEngagements) continue;

        // 先解攔截點再看資源。順序不能顛倒：
        // 若先被通道擋下就跳過，會把「本來就打不到」誤記成「被飽和擋掉」。
        const sol = solveIntercept(rt, track, geom, c, t, horizonS, stepS);
        if (!sol) continue;

        const interceptTarget = {
          lon: sol.point.lon,
          lat: sol.point.lat,
          altitudeM: sol.point.altitudeM,
        };
        if (
          shooterCheck(rt.site, interceptTarget, {
            threat: track.threat,
            sensors: [],
            mode,
            aspect,
          }) !== null
        ) {
          continue;
        }
        // 中途指令的前提：攔截時刻 C2 群組仍看得到目標。
        if (!detectedByAny(groups[gi], interceptTarget, track.threat, mode)) continue;

        const need = rt.roundsPerEngagement * salvo;
        const freeChannel = rt.busyUntilS.findIndex((until) => until <= t);
        if (freeChannel < 0) {
          rt.load.deniedByChannel++;
          c.blockedByChannel = true;
          continue;
        }
        if (rt.roundsLeft < need) {
          rt.load.deniedByMagazine++;
          c.blockedByMagazine = true;
          continue;
        }

        const channelFreeS = sol.timeS + rt.assessS;
        rt.busyUntilS[freeChannel] = channelFreeS;
        rt.roundsLeft -= need;
        rt.engagedUntilS.set(c.id, channelFreeS);
        rt.engagementCount.set(c.id, (rt.engagementCount.get(c.id) ?? 0) + 1);
        rt.load.roundsFired += need;
        rt.load.shotCount++;

        const shot: Shot = {
          siteId: rt.site.id,
          contactId: c.id,
          trackId: c.trackId,
          fireTimeS: t,
          fireRangeM: distanceM,
          interceptTimeS: sol.timeS,
          interceptRangeM: rt.missileMps * (sol.timeS - t),
          interceptLon: sol.point.lon,
          interceptLat: sol.point.lat,
          interceptAltM: sol.point.altitudeM,
          rounds: need,
          channelFreeS,
        };
        shots.push(shot);
        c.shots.push(shot);
      }
    }
  }

  return finish(contacts, rts, shots, horizonS, stepS, skipped, t0, minReactionS);
}

/**
 * 解攔截點：求 t 使得「射手到目標的距離」等於「飛彈已飛的距離」。
 *
 *     f(t) = |p(t) − b| − v_m·(t − t_fire) = 0
 *
 * 只要飛彈速度大於目標速度，f 嚴格遞減，根唯一 —— 粗掃找到第一次變號後二分即可。
 * 若飛彈追不上（例如 35 快砲對中段彈道飛彈），f 不會變號，回傳 null，
 * 該射手就自然不會對這個目標開火。這是正確的結果，不是失敗。
 */
function solveIntercept(
  rt: RtBattery,
  track: TimelineTrack,
  geom: TrackGeometry,
  contact: Contact,
  fireTimeS: number,
  horizonS: number,
  stepS: number,
): { timeS: number; point: TrackWaypoint } | null {
  const limit = Math.min(contact.arrivalTimeS, horizonS);
  if (limit < fireTimeS) return null;

  const f = (t: number): number | null => {
    const p = contactPositionAt(track, geom, contact, t);
    if (!p) return null;
    return bearingDistance(rt.site, p).distanceM - rt.missileMps * (t - fireTimeS);
  };

  const f0 = f(fireTimeS);
  if (f0 === null) return null;
  if (f0 <= 0) {
    const p = contactPositionAt(track, geom, contact, fireTimeS);
    return p ? { timeS: fireTimeS, point: p } : null;
  }

  const coarse = Math.max(0.25, Math.min(stepS, 1));
  let lo = fireTimeS;

  for (let t = fireTimeS + coarse; ; t += coarse) {
    const tc = Math.min(t, limit);
    const v = f(tc);
    if (v === null) return null;

    if (v <= 0) {
      let a = lo;
      let b = tc;
      for (let k = 0; k < 30; k++) {
        const m = (a + b) / 2;
        const fm = f(m);
        if (fm === null || fm <= 0) b = m;
        else a = m;
      }
      const p = contactPositionAt(track, geom, contact, b);
      return p ? { timeS: b, point: p } : null;
    }

    if (tc >= limit) return null; // 目標先抵達目標區，飛彈追不上
    lo = tc;
  }
}

function finish(
  contacts: RtContact[],
  rts: RtBattery[],
  shots: Shot[],
  horizonS: number,
  stepS: number,
  skipped: SkippedBattery[],
  t0: number,
  minReactionS: number,
): TimelineResult {
  const outcomes: ContactOutcome[] = contacts.map((c) => {
    const detected = c.detectedAt.filter((v): v is number => v !== undefined);
    const firstDetectS = detected.length > 0 ? Math.min(...detected) : null;

    let leakReason: LeakReason | null = null;
    if (c.shots.length === 0) {
      if (firstDetectS === null) leakReason = 'never-detected';
      else if (c.blockedByChannel) leakReason = 'channels-saturated';
      else if (c.blockedByMagazine) leakReason = 'magazine-empty';
      else if (c.everInReach && c.arrivalTimeS - firstDetectS < minReactionS)
        leakReason = 'too-late';
      else leakReason = 'never-in-envelope';
    }

    return {
      contactId: c.id,
      trackId: c.trackId,
      index: c.index,
      entryTimeS: c.entryTimeS,
      arrivalTimeS: c.arrivalTimeS,
      firstDetectS,
      shots: c.shots,
      leakReason,
    };
  });

  const engagedCount = outcomes.filter((o) => o.shots.length > 0).length;

  return {
    contacts: outcomes,
    loads: rts.map((r) => r.load),
    shots,
    summary: {
      contactCount: outcomes.length,
      engagedCount,
      leakCount: outcomes.length - engagedCount,
      totalShots: shots.length,
      meanShotsPerEngaged: engagedCount > 0 ? shots.length / engagedCount : 0,
    },
    horizonS,
    stepS,
    skipped,
    computeMs: performance.now() - t0,
  };
}
