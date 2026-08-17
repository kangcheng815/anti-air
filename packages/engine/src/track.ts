/**
 * 威脅航跡：把地圖上的一條線，變成一個隨時間移動的目標。
 *
 * 前三期的每一張圖都是**某一瞬間的空間切片**。加上時間之後，能問的問題
 * 完全不同：不是「這一格打不打得到」，而是「這個目標從進入到抵達目標區的
 * 這段時間裡，防空網總共有幾次射擊機會」。
 *
 * 刻意不做的事：
 *   - 不模擬飛行動力學。定速、沿折線飛行、高度沿全程線性內插。
 *     真實航跡有轉彎半徑、爬升率、能量管理，但那些參數沒有公開資料，
 *     加進來只是把捏造的數字包裝成精密。
 *   - 不做規避機動、不做電子作戰。這兩者都會大幅改變結果，
 *     而它們的效果無法用公開資料量化 —— 寧可缺席，也不要給一個假的數字。
 *
 * 一條航跡可以帶 count 個架次（波次），彼此以 spacingS 秒錯開。
 * 飽和攻擊不需要畫二十條線，那只是同一條航跡上的二十個接觸。
 */

import { destination, localOffsetM, type LonLat } from './geodesy.js';

export interface TrackWaypoint extends LonLat {
  /** 海平面基準高度 (m)。逐航點指定，才能表達「進入時高空、突防段下降」。 */
  altitudeM: number;
}

export interface Track {
  id: string;
  waypoints: TrackWaypoint[];
  /** 對地速度 (m/s)。全程定速。 */
  speedMps: number;
  /** 同一條航跡上的架次數。 */
  count: number;
  /** 相鄰架次的發起間隔 (s)。0 = 同時進入（真正的同時飽和）。 */
  spacingS: number;
  /** 首架次進入的時間 (s)。 */
  startTimeS: number;
}

export interface TrackGeometry {
  /** 每個航段的起始方位角（度）。長度 = 航點數 − 1。 */
  bearingDeg: Float64Array;
  /** 每個航段的長度 (m)。長度 = 航點數 − 1。 */
  legM: Float64Array;
  /** 到第 i 個航點的累積距離 (m)。長度 = 航點數。 */
  cumM: Float64Array;
  totalM: number;
  /** 單一架次走完全程所需時間 (s)。 */
  durationS: number;
}

/**
 * 一個「接觸」＝ 航跡上的一個架次。
 * 位置由 (航跡, index) 決定，時間由 entryTimeS 平移。
 */
export interface Contact {
  id: string;
  trackId: string;
  /** 第幾架次，由 0 起算。 */
  index: number;
  entryTimeS: number;
  /** 抵達航跡終點（＝目標區）的時間 (s)。 */
  arrivalTimeS: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * 航段的方位角與長度：`destination()` 的反運算。
 *
 * 不能直接用 `bearingDistance()` —— 它是本地平面近似，在 200 km 的航段上
 * 有 0.7% 誤差。若拿那組方位/距離去餵 `destination()`，航跡的終點會離
 * 使用者點的位置**1.4 km**，而終點正是目標區。整條航跡的時序都會跟著錯。
 *
 * 做法是對近似解迭代修正：把「推算終點」到「實際終點」的偏差分解成
 * 沿航向與側向兩個分量，分別修正距離與方位角。收斂很快（誤差平方階），
 * 而且由於用的是同一個 `destination()`，終點誤差被壓到公分級而不只是變小。
 * 這只在建立航跡時算一次，不在逐時步的熱路徑上。
 */
function legBearingDistance(a: LonLat, b: LonLat): { azimuthDeg: number; distanceM: number } {
  const { dx, dy } = localOffsetM(a, b);
  let azDeg = (Math.atan2(dx, dy) * RAD + 360) % 360;
  let dist = Math.hypot(dx, dy);
  if (dist === 0) return { azimuthDeg: 0, distanceM: 0 };

  for (let k = 0; k < 6; k++) {
    const p = destination(a, azDeg, dist);
    const err = localOffsetM(p, b);
    const s = Math.sin(azDeg * DEG);
    const c = Math.cos(azDeg * DEG);
    const along = err.dx * s + err.dy * c;
    const cross = err.dx * c - err.dy * s;
    dist += along;
    if (dist <= 0) return { azimuthDeg: azDeg, distanceM: 0 };
    azDeg = (((azDeg + (Math.atan2(cross, dist) * RAD)) % 360) + 360) % 360;
    if (Math.abs(along) < 1e-4 && Math.abs(cross) < 1e-4) break;
  }

  return { azimuthDeg: azDeg, distanceM: dist };
}

export function trackGeometry(track: Track): TrackGeometry {
  const wps = track.waypoints;
  const n = Math.max(0, wps.length - 1);
  const bearingDeg = new Float64Array(n);
  const legM = new Float64Array(n);
  const cumM = new Float64Array(wps.length);

  for (let i = 0; i < n; i++) {
    const { azimuthDeg, distanceM } = legBearingDistance(wps[i], wps[i + 1]);
    bearingDeg[i] = azimuthDeg;
    legM[i] = distanceM;
    cumM[i + 1] = cumM[i] + distanceM;
  }

  const totalM = wps.length > 0 ? cumM[wps.length - 1] : 0;
  return {
    bearingDeg,
    legM,
    cumM,
    totalM,
    durationS: track.speedMps > 0 ? totalM / track.speedMps : Infinity,
  };
}

/**
 * 沿航跡前進 sM 公尺後的位置。超出兩端時夾住。
 *
 * 航段內用 `destination()` 沿該段起始方位角推進，而不是對經緯度做線性內插：
 * 線性內插在 100 km 級的航段上會偏離實際路徑數百公尺，
 * 而這個工具正是在討論「差幾公里就打不到」的問題。
 */
export function positionAlong(track: Track, geom: TrackGeometry, sM: number): TrackWaypoint {
  const wps = track.waypoints;
  if (wps.length === 0) throw new Error('航跡沒有任何航點');
  if (wps.length === 1) return { ...wps[0] };

  const s = Math.min(Math.max(sM, 0), geom.totalM);

  // 找出所在航段。航點數通常個位數，線性搜尋即可。
  let i = 0;
  while (i < geom.legM.length - 1 && s > geom.cumM[i + 1]) i++;

  const into = s - geom.cumM[i];
  const leg = geom.legM[i];
  const t = leg > 0 ? into / leg : 0;
  const p = destination(wps[i], geom.bearingDeg[i], into);

  return {
    lon: p.lon,
    lat: p.lat,
    altitudeM: wps[i].altitudeM + (wps[i + 1].altitudeM - wps[i].altitudeM) * t,
  };
}

/** 把一條航跡展開成各架次。 */
export function expandContacts(track: Track, geom: TrackGeometry): Contact[] {
  const count = Math.max(1, Math.round(track.count));
  const out: Contact[] = [];
  for (let i = 0; i < count; i++) {
    const entry = track.startTimeS + i * track.spacingS;
    out.push({
      id: `${track.id}#${i}`,
      trackId: track.id,
      index: i,
      entryTimeS: entry,
      arrivalTimeS: entry + geom.durationS,
    });
  }
  return out;
}

/**
 * 某架次在指定時刻的位置。
 * 尚未進入、或已抵達終點之後，回傳 null —— 目標在那些時刻不存在，
 * 而不是停在起點或終點。這個區別會直接影響飽和分析的通道佔用。
 */
export function contactPositionAt(
  track: Track,
  geom: TrackGeometry,
  contact: Contact,
  timeS: number,
): TrackWaypoint | null {
  if (timeS < contact.entryTimeS) return null;
  if (timeS > contact.arrivalTimeS) return null;
  return positionAlong(track, geom, (timeS - contact.entryTimeS) * track.speedMps);
}
