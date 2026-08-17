/**
 * 航跡詳情。與陣地詳情共用右側面板，一次只顯示一個。
 *
 * 這裡的每一個欄位都會直接改變時間軸的結果，而且改變的方式往往不直覺 ——
 * 例如把架次間隔從 30 s 縮到 5 s，總架次不變，但通道飽和的程度完全不同。
 * 所以欄位旁邊都附上「這個參數會影響什麼」。
 */

import { useStore } from '../state/store';
import { THREATS, THREAT_BY_ID } from '../data/threats';
import { toEngineTrack } from '../analysis/timelineModel';
import { trackGeometry } from '@anti-air/engine';

export function TrackDetail({ trackId }: { trackId: string }) {
  const track = useStore((s) => s.tracks.find((t) => t.id === trackId));
  const updateTrack = useStore((s) => s.updateTrack);
  const removeTrack = useStore((s) => s.removeTrack);
  const trackDrawing = useStore((s) => s.trackDrawing);
  const finishTrackDraw = useStore((s) => s.finishTrackDraw);
  const setTimelineOpen = useStore((s) => s.setTimelineOpen);

  if (!track) return null;

  const threat = THREAT_BY_ID.get(track.threatId);
  const engine = toEngineTrack(track);
  const geom = engine ? trackGeometry(engine) : null;
  const lastEntryS = track.startTimeS + Math.max(0, track.count - 1) * track.spacingS;

  const patch = (p: Partial<typeof track>) => updateTrack(track.id, p);

  return (
    <aside className="panel right">
      <h2>航跡詳情</h2>

      {trackDrawing && (
        <div className="limit-box">
          <strong>正在畫航跡</strong>
          <p>在地圖上依序點出路徑，雙擊或按下方按鈕結束。已點 {track.path.length} 點。</p>
          <button className="linklike" onClick={finishTrackDraw}>
            完成航跡
          </button>
        </div>
      )}

      <label className="field">
        <span>名稱</span>
        <input value={track.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>

      <label className="field">
        <span>
          威脅型別
          <em>決定 RCS，進而決定整條航跡被偵獲的距離</em>
        </span>
        <select
          value={track.threatId}
          onChange={(e) => {
            const t = THREAT_BY_ID.get(e.target.value);
            // 換威脅時同步帶入該型別的典型速度與高度：巡弋飛彈與彈道飛彈
            // 差好幾個數量級，沿用舊值幾乎一定是錯的。
            patch({
              threatId: e.target.value,
              speedMps: Math.round(t?.speed_mps.nominal ?? track.speedMps),
              altStartM: t?.typical_altitude_m ?? track.altStartM,
              altEndM: t?.typical_altitude_m ?? track.altEndM,
            });
          }}
        >
          {THREATS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name_zh}（RCS {t.rcs_m2.nominal} m²）
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>對地速度 (m/s)</span>
        <input
          type="number"
          min={20}
          step={10}
          value={track.speedMps}
          onChange={(e) => patch({ speedMps: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>進入高度 (m)</span>
          <input
            type="number"
            min={0}
            step={100}
            value={Math.round(track.altStartM)}
            onChange={(e) => patch({ altStartM: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="field">
          <span>終端高度 (m)</span>
          <input
            type="number"
            min={0}
            step={100}
            value={Math.round(track.altEndM)}
            onChange={(e) => patch({ altEndM: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
      </div>
      <p className="hint">
        兩者不同即為下降（或爬升）剖面，沿航跡累積距離線性內插。
        高度在這裡比在涵蓋圖上更關鍵：它同時決定運動學射程與地形視線。
      </p>

      <h3>波次</h3>
      <div className="field-row">
        <label className="field">
          <span>架次數</span>
          <input
            type="number"
            min={1}
            max={200}
            value={track.count}
            onChange={(e) =>
              patch({ count: Math.min(200, Math.max(1, Math.round(Number(e.target.value) || 1))) })
            }
          />
        </label>
        <label className="field">
          <span>間隔 (s)</span>
          <input
            type="number"
            min={0}
            step={5}
            value={track.spacingS}
            onChange={(e) => patch({ spacingS: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
      </div>
      <p className="hint">
        間隔設 0 就是全部同時進入 —— 這是壓垮通道數最直接的方式。
        總架次不變、只縮短間隔，飽和程度就會完全不同。
      </p>

      <label className="field">
        <span>首架次進入時間 (s)</span>
        <input
          type="number"
          min={0}
          step={10}
          value={track.startTimeS}
          onChange={(e) => patch({ startTimeS: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>

      <h3>航跡幾何</h3>
      <table className="stats">
        <tbody>
          <tr>
            <th>航點數</th>
            <td>{track.path.length}</td>
          </tr>
          <tr>
            <th>全長</th>
            <td>{geom ? `${(geom.totalM / 1000).toFixed(1)} km` : '—'}</td>
          </tr>
          <tr>
            <th>單架次飛行時間</th>
            <td>{geom ? `${geom.durationS.toFixed(0)} s` : '—'}</td>
          </tr>
          <tr className="highlight">
            <th>末架次抵達</th>
            <td>{geom ? `T+${(lastEntryS + geom.durationS).toFixed(0)} s` : '—'}</td>
          </tr>
        </tbody>
      </table>

      {!engine && (
        <div className="limit-box empty">
          <strong>尚無法模擬</strong>
          <p>航跡需要至少兩個航點。</p>
        </div>
      )}

      {threat?.note && <p className="hint">{threat.note}</p>}

      <button className="wide" onClick={() => setTimelineOpen(true)}>
        開啟接戰時間軸
      </button>
      <button className="danger wide" onClick={() => removeTrack(track.id)}>
        刪除此航跡
      </button>
    </aside>
  );
}
