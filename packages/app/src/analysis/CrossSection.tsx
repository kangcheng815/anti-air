/**
 * 垂直剖面圖 —— Phase 3 的第二個主打功能。
 *
 * 在地圖上畫一條線，看側視圖：地形剖面 + 每個 (距離, 高度) 格點的接戰縱深。
 * 低空走廊在這張圖上是**一條看得見的縫** —— 貼著地形、被塗成缺口色的那一條。
 *
 * DESIGN.md §6.2 主張這張圖的資訊密度遠高於 3D 包絡體，也是本專案不採用
 * CesiumJS 的主因之一。
 */

import { useEffect, useRef, useState } from 'react';
import { detectionCheck, shooterCheck, type SiteState } from '@anti-air/engine';
import { useStore } from '../state/store';
import { THREAT_BY_ID } from '../data/threats';
import { mvaClient, TERRAIN_BASE_URL } from '../terrain/mvaClient';
import { toSiteStates, sensorsFor } from './siteStates';
import { DEPTH_BANDS } from './depthLayer';
import { useCanvasSize } from './useCanvasSize';

const SAMPLES = 320; // 水平方向格數
const LEVELS = 180; // 垂直方向格數
const MAX_ALT_M = 20_000;

interface Profile {
  elevationsM: Float32Array;
  lons: Float64Array;
  lats: Float64Array;
  lengthM: number;
}

export function CrossSection() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeEpoch = useCanvasSize(canvasRef);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sectionLine = useStore((s) => s.sectionLine);
  const sectionDrawing = useStore((s) => s.sectionDrawing);
  const clearSection = useStore((s) => s.clearSection);
  const sites = useStore((s) => s.sites);
  const mva = useStore((s) => s.mva);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const manifest = useStore((s) => s.terrainManifest);
  const threatId = useStore((s) => s.threatId);
  const estimateMode = useStore((s) => s.estimateMode);
  const aspect = useStore((s) => s.aspect);
  const c2Mode = useStore((s) => s.c2Mode);
  const altitudeM = useStore((s) => s.altitudeM);

  // --- 取地形剖面（在 worker 裡，因為圖磚快取在那邊）---
  useEffect(() => {
    if (!sectionLine || sectionDrawing) {
      setProfile(null);
      return;
    }
    if (!manifest) {
      // 沒有地形資料時仍可畫接戰包絡，只是地面一律當成海平面。
      setProfile({
        elevationsM: new Float32Array(SAMPLES),
        lons: Float64Array.from({ length: SAMPLES }, (_, i) =>
          lerp(sectionLine[0][0], sectionLine[1][0], i / (SAMPLES - 1)),
        ),
        lats: Float64Array.from({ length: SAMPLES }, (_, i) =>
          lerp(sectionLine[0][1], sectionLine[1][1], i / (SAMPLES - 1)),
        ),
        lengthM: haversine(sectionLine[0], sectionLine[1]),
      });
      return;
    }

    let cancelled = false;
    setError(null);
    mvaClient
      .profile({
        id: `profile:${sectionLine.flat().join(',')}`,
        kind: 'profile',
        from: sectionLine[0],
        to: sectionLine[1],
        samples: SAMPLES,
        zoom: manifest.zoom,
        terrainBaseUrl: TERRAIN_BASE_URL,
      })
      .then((res) => {
        if (cancelled) return;
        setProfile({
          elevationsM: res.elevationsM,
          lons: res.lons,
          lats: res.lats,
          lengthM: res.lengthM,
        });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [sectionLine, sectionDrawing, manifest]);

  // --- 繪製 ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !profile) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const H = (canvas.height = canvas.clientHeight * devicePixelRatio);

    const threat = THREAT_BY_ID.get(threatId);
    const states = toSiteStates(sites, mva, terrainEnabled);
    const sharedSensors = c2Mode === 'shared' ? states.filter((s) => s.system.sensor) : null;
    const sensorsOf = new Map<string, SiteState[]>();
    for (const s of states) sensorsOf.set(s.id, sensorsFor(s, states, c2Mode));

    ctx.clearRect(0, 0, W, H);

    // 接戰縱深網格
    const cellW = W / SAMPLES;
    const cellH = H / LEVELS;
    if (threat && states.length > 0) {
      for (let i = 0; i < SAMPLES; i++) {
        const lon = profile.lons[i];
        const lat = profile.lats[i];
        const ground = profile.elevationsM[i];

        for (let j = 0; j < LEVELS; j++) {
          // 由下而上：j=0 是海平面
          const alt = (MAX_ALT_M * (j + 0.5)) / LEVELS;
          if (alt < ground) continue; // 在地面以下，不畫

          const target = { lon, lat, altitudeM: alt };

          let detected = true;
          if (sharedSensors) {
            detected = sharedSensors.some(
              (s) => detectionCheck(s, target, threat, estimateMode) === null,
            );
          }

          let depth = 0;
          if (detected) {
            for (const battery of states) {
              if (
                shooterCheck(battery, target, {
                  threat,
                  sensors: [],
                  mode: estimateMode,
                  aspect,
                }) !== null
              ) {
                continue;
              }
              if (sharedSensors) {
                depth++;
                continue;
              }
              const own = sensorsOf.get(battery.id) ?? [];
              if (own.some((s) => detectionCheck(s, target, threat, estimateMode) === null)) {
                depth++;
              }
            }
          }

          if (depth === 0 && !detected) continue; // 未偵獲且無射手：留白，不是缺口
          const band = DEPTH_BANDS[Math.min(depth, DEPTH_BANDS.length - 1)];
          ctx.fillStyle = `rgba(${band.color[0]},${band.color[1]},${band.color[2]},0.62)`;
          ctx.fillRect(i * cellW, H - (j + 1) * cellH, cellW + 1, cellH + 1);
        }
      }
    }

    // 地形剖面（實心填到底）
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < SAMPLES; i++) {
      const y = H - (profile.elevationsM[i] / MAX_ALT_M) * H;
      ctx.lineTo((i / (SAMPLES - 1)) * W, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = '#6b6157';
    ctx.fill();

    // 目前高度滑桿位置的參考線
    const yAlt = H - (altitudeM / MAX_ALT_M) * H;
    ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    ctx.moveTo(0, yAlt);
    ctx.lineTo(W, yAlt);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [
    profile,
    sites,
    mva,
    terrainEnabled,
    threatId,
    estimateMode,
    aspect,
    c2Mode,
    altitudeM,
    sizeEpoch,
  ]);

  if (!sectionLine && !sectionDrawing) return null;

  const peakM = profile ? Math.max(...Array.from(profile.elevationsM)) : 0;

  return (
    <section className="cross-section">
      <div className="cs-head">
        <strong>垂直剖面</strong>
        {sectionDrawing && <span className="hint-inline">在地圖上點兩下決定剖面線</span>}
        {profile && (
          <span className="hint-inline">
            長度 {(profile.lengthM / 1000).toFixed(1)} km ｜ 最高地形 {peakM.toFixed(0)} m ｜
            縱軸 0–20 km
          </span>
        )}
        {error && <span className="hint-inline error">{error}</span>}
        <button className="linklike" onClick={clearSection}>
          關閉
        </button>
      </div>
      <div className="cs-body">
        <div className="cs-axis">
          <span>20 km</span>
          <span>10 km</span>
          <span>0</span>
        </div>
        <canvas ref={canvasRef} className="cs-canvas" />
      </div>
    </section>
  );
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function haversine([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const R = 6371008.8;
  const D = Math.PI / 180;
  const dp = (lat2 - lat1) * D;
  const dl = (lon2 - lon1) * D;
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
