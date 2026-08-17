/**
 * 接戰時間軸 —— Phase 4 的主畫面。
 *
 * 一列 = 一個接觸（航跡上的一個架次）。橫軸 = 時間。
 * 每一列上看得到：什麼時候被偵獲、什麼時候被射擊、飛彈飛了多久、
 * 以及沒被打到的那些，卡在哪一關。
 *
 * 這張圖回答的是前三期問不到的問題：涵蓋圖告訴你「這裡打得到」，
 * 這張圖告訴你「同時來三十個的時候，打得到有什麼用」。
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { BY_ID, hueOf } from '../data/catalog';
import { LEAK_HINT, LEAK_LABEL, useTimelineRun } from './timelineModel';
import { useCanvasSize } from './useCanvasSize';
import type { TimelineResult } from '@anti-air/engine';

/** 漏網原因的色票。與縱深熱圖刻意不同色系，避免兩張圖被誤讀成同一件事。 */
const LEAK_COLOR: Record<string, string> = {
  'never-detected': '#7b3f9d',
  'channels-saturated': '#c0392b',
  'magazine-empty': '#b8651b',
  'too-late': '#a08a1e',
  'never-in-envelope': '#4a5568',
};

const LABEL_W = 108;
const AXIS_H = 16;
const MIN_ROW_H = 3;
const MAX_ROW_H = 18;

export function TimelinePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeEpoch = useCanvasSize(canvasRef);
  const [playing, setPlaying] = useState(false);

  const timelineOpen = useStore((s) => s.timelineOpen);
  const setTimelineOpen = useStore((s) => s.setTimelineOpen);
  const tracks = useStore((s) => s.tracks);
  const sites = useStore((s) => s.sites);
  const salvoSize = useStore((s) => s.salvoSize);
  const setSalvoSize = useStore((s) => s.setSalvoSize);
  const maxEngagements = useStore((s) => s.maxEngagements);
  const setMaxEngagements = useStore((s) => s.setMaxEngagements);
  const simTimeS = useStore((s) => s.simTimeS);
  const setSimTime = useStore((s) => s.setSimTime);
  const trackDrawing = useStore((s) => s.trackDrawing);

  const run = useTimelineRun();
  const result = run?.result ?? null;
  const horizonS = result?.horizonS ?? 0;

  // --- 播放。用 setInterval 而不是 rAF：更新頻率只有 10 Hz，
  //     而 rAF 在頁面不合成時完全不會送出（實測過），播放就會靜默卡住。
  useEffect(() => {
    if (!playing || horizonS <= 0) return;
    const id = window.setInterval(() => {
      const s = useStore.getState();
      const next = s.simTimeS + 1;
      if (next > horizonS) {
        setPlaying(false);
        s.setSimTime(horizonS);
      } else {
        s.setSimTime(next);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, horizonS]);

  useEffect(() => {
    if (simTimeS > horizonS) setSimTime(0);
  }, [horizonS, simTimeS, setSimTime]);

  // --- 繪製 ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = devicePixelRatio || 1;
    const W = (canvas.width = canvas.clientWidth * dpr);
    const H = (canvas.height = canvas.clientHeight * dpr);
    ctx.clearRect(0, 0, W, H);
    if (result.contacts.length === 0 || horizonS <= 0) return;

    const labelW = LABEL_W * dpr;
    const axisH = AXIS_H * dpr;
    const plotW = W - labelW;
    const plotH = H - axisH;
    const n = result.contacts.length;
    const rowH = Math.max(MIN_ROW_H * dpr, Math.min(MAX_ROW_H * dpr, plotH / n));
    const x = (t: number) => labelW + (t / horizonS) * plotW;

    const siteColor = new Map<string, string>();
    for (const s of sites) {
      const sys = BY_ID.get(s.systemId);
      siteColor.set(s.id, sys ? `hsl(${hueOf(sys)}, 78%, 45%)` : '#666');
    }

    // 時間格線
    const gridStep = niceStep(horizonS);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let t = 0; t <= horizonS + 1e-6; t += gridStep) {
      const px = x(t);
      ctx.strokeStyle = '#e6e9ee';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, plotH);
      ctx.stroke();
      ctx.fillStyle = '#8a919c';
      ctx.textAlign = t === 0 ? 'left' : 'center';
      ctx.fillText(`${Math.round(t)}s`, px + (t === 0 ? 2 * dpr : 0), plotH + 3 * dpr);
    }

    // 逐列
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const c = result.contacts[i];
      const yTop = i * rowH;
      const yMid = yTop + rowH / 2;
      const barH = Math.max(2 * dpr, rowH * 0.62);

      // 存在區間
      ctx.fillStyle = c.leakReason ? hexA(LEAK_COLOR[c.leakReason] ?? '#4a5568', 0.2) : '#e8edf3';
      ctx.fillRect(x(c.entryTimeS), yMid - barH / 2, x(c.arrivalTimeS) - x(c.entryTimeS), barH);

      // 偵獲時刻
      if (c.firstDetectS !== null) {
        ctx.strokeStyle = '#3d4c5c';
        ctx.lineWidth = 1.4 * dpr;
        ctx.beginPath();
        ctx.moveTo(x(c.firstDetectS), yMid - barH / 2);
        ctx.lineTo(x(c.firstDetectS), yMid + barH / 2);
        ctx.stroke();
      }

      // 每一次射擊：發射 → 攔截的飛行段 + 攔截點
      for (const shot of c.shots) {
        const color = siteColor.get(shot.siteId) ?? '#666';
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2 * dpr, barH * 0.5);
        ctx.beginPath();
        ctx.moveTo(x(shot.fireTimeS), yMid);
        ctx.lineTo(x(shot.interceptTimeS), yMid);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x(shot.interceptTimeS), yMid, Math.max(1.6 * dpr, barH * 0.34), 0, Math.PI * 2);
        ctx.fill();
      }

      // 抵達目標區：漏網者畫一條實心終止線，被接戰者不畫
      if (c.leakReason) {
        ctx.strokeStyle = LEAK_COLOR[c.leakReason] ?? '#4a5568';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(x(c.arrivalTimeS), yMid - barH / 2 - dpr);
        ctx.lineTo(x(c.arrivalTimeS), yMid + barH / 2 + dpr);
        ctx.stroke();
      }

      // 列標籤（列高夠才畫，否則會糊成一團）
      if (rowH >= 9 * dpr) {
        ctx.fillStyle = '#4a5568';
        ctx.textAlign = 'right';
        ctx.fillText(labelOf(c.trackId, c.index, tracks), labelW - 5 * dpr, yMid);
      }
    }

    // 時間游標
    const cx = x(Math.min(simTimeS, horizonS));
    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, plotH);
    ctx.stroke();
  }, [result, horizonS, simTimeS, sites, tracks, sizeEpoch]);

  if (!timelineOpen) return null;

  const scrub = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || horizonS <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left - LABEL_W) / (rect.width - LABEL_W);
    setSimTime(Math.max(0, Math.min(horizonS, frac * horizonS)));
  };

  return (
    <section className="timeline">
      <div className="cs-head">
        <strong>接戰時間軸</strong>
        {trackDrawing && <span className="hint-inline">正在畫航跡…</span>}
        {result && <Summary result={result} />}
        {!result && (
          <span className="hint-inline">
            需要至少一條航跡與一個陣地。按「畫航跡」在地圖上點出進襲路線。
          </span>
        )}

        <label className="inline-field">
          齊射
          <select value={salvoSize} onChange={(e) => setSalvoSize(Number(e.target.value))}>
            <option value={1}>1 發</option>
            <option value={2}>2 發</option>
          </select>
        </label>
        <label className="inline-field">
          每目標接戰上限
          <select
            value={maxEngagements}
            onChange={(e) => setMaxEngagements(Number(e.target.value))}
          >
            <option value={1}>1 次</option>
            <option value={2}>2 次</option>
            <option value={3}>3 次</option>
          </select>
        </label>

        <button
          className={playing ? 'active-btn' : ''}
          onClick={() => setPlaying((p) => !p)}
          disabled={horizonS <= 0}
        >
          {playing ? '暫停' : '播放'}
        </button>
        <span className="mono clock">
          T+{simTimeS.toFixed(0)}s / {horizonS.toFixed(0)}s
        </span>
        <button className="linklike" onClick={() => setTimelineOpen(false)}>
          關閉
        </button>
      </div>

      <div className="tl-body">
        <canvas ref={canvasRef} className="tl-canvas" onMouseDown={scrub} onMouseMove={(e) => e.buttons === 1 && scrub(e)} />
        {result && <LoadTable result={result} />}
      </div>
    </section>
  );
}

function Summary({ result }: { result: TimelineResult }) {
  const { summary } = result;
  const leakByReason = new Map<string, number>();
  for (const c of result.contacts) {
    if (c.leakReason) leakByReason.set(c.leakReason, (leakByReason.get(c.leakReason) ?? 0) + 1);
  }

  return (
    <span className="tl-summary">
      <span>
        接觸 <b>{summary.contactCount}</b>
      </span>
      <span>
        射擊機會 <b>{summary.totalShots}</b>
      </span>
      <span>
        未被接戰 <b className={summary.leakCount > 0 ? 'bad' : ''}>{summary.leakCount}</b>
      </span>
      {[...leakByReason].map(([reason, n]) => (
        <span key={reason} className="tl-chip" title={LEAK_HINT[reason]}>
          <i style={{ background: LEAK_COLOR[reason] }} />
          {LEAK_LABEL[reason]} {n}
        </span>
      ))}
      <span className="hint-inline">{result.computeMs.toFixed(0)} ms</span>
    </span>
  );
}

function LoadTable({ result }: { result: TimelineResult }) {
  const sites = useStore((s) => s.sites);
  const nameOf = (id: string) => sites.find((s) => s.id === id)?.name ?? id;

  if (result.loads.length === 0) return null;

  return (
    <div className="tl-loads">
      <table className="stats">
        <thead>
          <tr>
            <th>陣地</th>
            <th>射擊</th>
            <th>通道尖峰</th>
            <th>用彈</th>
          </tr>
        </thead>
        <tbody>
          {result.loads.map((l) => (
            <tr key={l.siteId}>
              <th title={l.deniedByChannel > 0 ? `因通道全滿錯失 ${l.deniedByChannel} 次` : undefined}>
                {nameOf(l.siteId)}
                {l.deniedByChannel > 0 && <span className="bad"> ⚠</span>}
              </th>
              <td>{l.shotCount}</td>
              <td className={l.peakChannelsUsed >= l.channels ? 'bad' : ''}>
                {l.peakChannelsUsed}/{l.channels}
              </td>
              <td>
                {l.roundsFired}
                {Number.isFinite(l.readyRounds) ? `/${l.readyRounds}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.skipped.length > 0 && (
        <p className="hint-inline error">
          {result.skipped.length} 個陣地缺少平均飛彈速度參數，未納入模擬。
        </p>
      )}
    </div>
  );
}

/** 讓格線落在人看得懂的秒數上。 */
function niceStep(spanS: number): number {
  const target = spanS / 8;
  const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  for (const s of steps) if (target <= s) return s;
  return 3600;
}

function labelOf(trackId: string, index: number, tracks: { id: string; name: string }[]): string {
  const t = tracks.find((x) => x.id === trackId);
  const base = t?.name ?? '航跡';
  const short = base.length > 9 ? `${base.slice(0, 8)}…` : base;
  return `${short} #${index + 1}`;
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
