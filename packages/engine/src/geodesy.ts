/**
 * 大地測量基礎。
 *
 * 設計決定：**不投影**。所有幾何運算直接在橢球上以「方位角 + 大地線距離」進行。
 * 理由見 DESIGN.md §7 —— 投影到 TWD97 / EPSG:3826 在台灣本島誤差可接受，
 * 但東沙、太平島、東引超出分帶範圍後誤差會爆掉，而這些正是海基兵力想討論的地方。
 *
 * 精度做法：用「該緯度、該方位角上的歐拉曲率半徑」取代固定球半徑。
 * 這讓球面公式在 100 km 內的誤差降到約 10 m 量級，而程式碼只多五行。
 */

const A = 6378137.0; // WGS84 長半軸 (m)
const F = 1 / 298.257223563; // 扁率
const E2 = F * (2 - F); // 第一偏心率平方

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export interface LonLat {
  lon: number; // 度，東經為正
  lat: number; // 度，北緯為正
}

/**
 * 指定緯度、指定方位角上的曲率半徑（歐拉半徑）。
 * α = 0 (正北) 時等於子午圈曲率半徑 M，α = 90° 時等於卯酉圈曲率半徑 N。
 */
export function radiusOfCurvature(latDeg: number, azimuthDeg: number): number {
  const sinLat = Math.sin(latDeg * DEG);
  const w = 1 - E2 * sinLat * sinLat;
  const N = A / Math.sqrt(w); // 卯酉圈
  const M = (A * (1 - E2)) / (w * Math.sqrt(w)); // 子午圈
  const ca = Math.cos(azimuthDeg * DEG);
  const sa = Math.sin(azimuthDeg * DEG);
  return 1 / ((ca * ca) / M + (sa * sa) / N);
}

/**
 * 大地線正算：從起點沿方位角前進指定距離。
 * 方位角以正北為 0、順時針為正（與雷達方位一致）。
 */
export function destination(origin: LonLat, azimuthDeg: number, distanceM: number): LonLat {
  const R = radiusOfCurvature(origin.lat, azimuthDeg);
  const delta = distanceM / R;
  const theta = azimuthDeg * DEG;
  const phi1 = origin.lat * DEG;
  const lambda1 = origin.lon * DEG;

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );

  return { lon: normalizeLon(lambda2 * RAD), lat: phi2 * RAD };
}

/**
 * 局部平面近似：把目標點相對原點的位移換成公尺（東為 +dx、北為 +dy）。
 *
 * 這是 destination() 的快速反運算，但**刻意用近似**：在 120 km 尺度上誤差
 * 小於 0.5%，而它會在縱深熱圖裡被呼叫數百萬次。畫涵蓋多邊形時仍用精確的
 * destination()，那裡點數少、精度值得付代價。兩者的分工是刻意的，不是疏忽。
 */
export function localOffsetM(
  origin: LonLat,
  point: LonLat,
): { dx: number; dy: number } {
  const mPerDegLat = 111_132.92 - 559.82 * Math.cos(2 * origin.lat * DEG);
  const mPerDegLon = 111_412.84 * Math.cos(origin.lat * DEG);
  let dLon = point.lon - origin.lon;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return { dx: dLon * mPerDegLon, dy: (point.lat - origin.lat) * mPerDegLat };
}

/** 由原點看向目標點的方位角（正北 0、順時針）與距離 (m)。使用 localOffsetM 的近似。 */
export function bearingDistance(
  origin: LonLat,
  point: LonLat,
): { azimuthDeg: number; distanceM: number } {
  const { dx, dy } = localOffsetM(origin, point);
  const az = (Math.atan2(dx, dy) * RAD + 360) % 360;
  return { azimuthDeg: az, distanceM: Math.hypot(dx, dy) };
}

function normalizeLon(lonDeg: number): number {
  return ((lonDeg + 540) % 360) - 180;
}

/**
 * 產生以指定點為圓心的大地線環。用來把「射程」轉成可繪製的多邊形，
 * 不需要任何投影，在高緯度也不會變形。
 *
 * @param radiiM 每個方位角的半徑（公尺）。長度即方位角取樣數，索引 i 對應方位角 i*360/n。
 *               半徑逐方位可變，正是為了表達地形遮蔽後的鋸齒狀涵蓋邊界。
 */
export function geodesicRing(center: LonLat, radiiM: ArrayLike<number>): LonLat[] {
  const n = radiiM.length;
  const ring: LonLat[] = new Array(n + 1);
  for (let i = 0; i < n; i++) {
    ring[i] = destination(center, (i * 360) / n, radiiM[i]);
  }
  ring[n] = ring[0]; // 閉合
  return ring;
}
