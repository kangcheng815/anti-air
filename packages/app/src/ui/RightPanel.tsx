import { useStore } from '../state/store';
import { BY_ID, TIER_LABEL } from '../data/catalog';
import { coverageFor } from '../map/coverage';
import { TrackDetail } from './TrackDetail';
import type { LimitingFactor } from '@anti-air/engine';

const LIMIT_LABEL: Record<LimitingFactor, string> = {
  kinematics: '運動學射程',
  horizon: '雷達地平線',
  terrain: '地形遮蔽',
  'altitude-limit': '超出高度上下限',
};

const LIMIT_HINT: Record<LimitingFactor, string> = {
  kinematics: '飛彈本身的能量不夠遠。拉高目標高度會顯著變大。',
  horizon: '地球曲率擋住視線 —— 飛彈打得到，但看不到。把陣地架高才有用，換更遠的飛彈沒用。',
  terrain: '地形遮蔽主導。此方位的低空是盲區。',
  'altitude-limit': '目標高度超出本系統的接戰高度範圍，完全無法接戰。',
};

const STATUS_LABEL = { ready: '戰備', reloading: '整補', down: '損毀' } as const;

export function RightPanel() {
  const selectedSiteId = useStore((s) => s.selectedSiteId);
  const sites = useStore((s) => s.sites);
  const updateSite = useStore((s) => s.updateSite);
  const removeSite = useStore((s) => s.removeSite);
  const altitudeM = useStore((s) => s.altitudeM);
  const estimateMode = useStore((s) => s.estimateMode);
  const aspect = useStore((s) => s.aspect);
  const setAspect = useStore((s) => s.setAspect);
  const mvaBySite = useStore((s) => s.mva);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const selectedTrackId = useStore((s) => s.selectedTrackId);

  const site = sites.find((s) => s.id === selectedSiteId);

  // 航跡與陣地共用這一格。store 保證兩者的選取互斥。
  if (selectedTrackId) return <TrackDetail trackId={selectedTrackId} />;

  if (!site) {
    return (
      <aside className="panel right">
        <h2>陣地詳情</h2>
        <p className="hint">在地圖或左側清單選一個陣地，或選一條威脅航跡。</p>
      </aside>
    );
  }

  const system = BY_ID.get(site.systemId);
  const mvaEntry = mvaBySite[site.id];
  const cov = coverageFor(site, {
    altitudeM,
    estimateMode,
    aspect,
    mvaBySite,
    terrainEnabled,
  });

  const radii = cov && !cov.empty ? Array.from(cov.outerM) : [];
  const sorted = [...radii].sort((a, b) => a - b);
  const stats = sorted.length
    ? {
        min: sorted[0] / 1000,
        median: sorted[Math.floor(sorted.length / 2)] / 1000,
        max: sorted[sorted.length - 1] / 1000,
        blindPct: (radii.filter((r) => r <= 0).length / radii.length) * 100,
      }
    : null;
  const terrainActive = cov?.limitedBy === 'terrain' || (stats !== null && stats.max - stats.min > 1);

  return (
    <aside className="panel right">
      <h2>陣地詳情</h2>

      <label className="field">
        <span>名稱</span>
        <input value={site.name} onChange={(e) => updateSite(site.id, { name: e.target.value })} />
      </label>

      <div className="field">
        <span>系統</span>
        <div className="readonly">
          {system?.name_zh ?? site.systemId}
          {system && <em>{TIER_LABEL[system.tier]}</em>}
        </div>
      </div>

      <div className="field">
        <span>座標</span>
        <div className="readonly mono">
          {site.lat.toFixed(4)}°N&nbsp;&nbsp;{site.lon.toFixed(4)}°E
        </div>
      </div>

      <label className="field">
        <span>
          陣地地面高程 (m)
          <em>
            {site.elevationSource === 'dem'
              ? mvaEntry?.status === 'ready'
                ? `來自 DEM（${mvaEntry.demElevationM?.toFixed(0)} m）`
                : '等待 DEM…'
              : '手動指定，DEM 不再覆蓋'}
          </em>
        </span>
        <input
          type="number"
          value={site.groundElevationM}
          step={10}
          onChange={(e) =>
            updateSite(site.id, {
              groundElevationM: Number(e.target.value) || 0,
              elevationSource: 'manual',
            })
          }
        />
      </label>

      {site.elevationSource === 'manual' && mvaEntry?.demElevationM !== undefined && (
        <button
          className="linklike"
          onClick={() =>
            updateSite(site.id, {
              elevationSource: 'dem',
              groundElevationM: Math.round(mvaEntry.demElevationM!),
            })
          }
        >
          ↩ 改回 DEM 值（{mvaEntry.demElevationM.toFixed(0)} m）
        </button>
      )}

      <label className="field">
        <span>狀態</span>
        <select
          value={site.status}
          onChange={(e) => updateSite(site.id, { status: e.target.value as typeof site.status })}
        >
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          本陣地待發彈
          <em>
            {site.readyRoundsOverride === null
              ? `沿用系統值 ${system?.engagement.ready_rounds?.nominal ?? '—'}（單一發射單元）`
              : '已覆寫；一個連的發射架數屬編制，不在系統目錄內'}
          </em>
        </span>
        <input
          type="number"
          min={0}
          step={1}
          placeholder={String(system?.engagement.ready_rounds?.nominal ?? '')}
          value={site.readyRoundsOverride ?? ''}
          onChange={(e) =>
            updateSite(site.id, {
              readyRoundsOverride: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0),
            })
          }
        />
      </label>

      <label className="field">
        <span>接近幾何</span>
        <select value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)}>
          <option value="head_on">迎頭</option>
          <option value="beam">側向</option>
          <option value="tail_chase">尾追</option>
        </select>
      </label>

      <h3>此高度下的涵蓋</h3>
      {!cov || cov.empty ? (
        <div className="limit-box empty">
          <strong>無涵蓋</strong>
          <p>{LIMIT_HINT['altitude-limit']}</p>
        </div>
      ) : (
        <>
          <table className="stats">
            <tbody>
              <tr>
                <th>目標高度</th>
                <td>{fmtAlt(altitudeM)}</td>
              </tr>
              <tr>
                <th>運動學射程</th>
                <td>{(cov.kinematicMaxM / 1000).toFixed(1)} km</td>
              </tr>
              <tr>
                <th>雷達地平線</th>
                <td>{(cov.horizonMaxM / 1000).toFixed(1)} km</td>
              </tr>
              {stats && terrainActive ? (
                <>
                  <tr className="highlight">
                    <th>有效半徑（中位數）</th>
                    <td>{stats.median.toFixed(1)} km</td>
                  </tr>
                  <tr>
                    <th>最短 / 最遠方位</th>
                    <td>
                      {stats.min.toFixed(1)} / {stats.max.toFixed(1)} km
                    </td>
                  </tr>
                  {stats.blindPct > 0 && (
                    <tr>
                      <th>完全遮蔽方位</th>
                      <td>{stats.blindPct.toFixed(0)}%</td>
                    </tr>
                  )}
                </>
              ) : (
                stats && (
                  <tr className="highlight">
                    <th>有效半徑</th>
                    <td>{stats.median.toFixed(1)} km</td>
                  </tr>
                )
              )}
              {cov.innerM[0] > 0 && (
                <tr>
                  <th>最小射程死區</th>
                  <td>{(cov.innerM[0] / 1000).toFixed(1)} km</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className={`limit-box ${cov.limitedBy}`}>
            <strong>限制因素：{LIMIT_LABEL[cov.limitedBy]}</strong>
            <p>{LIMIT_HINT[cov.limitedBy]}</p>
          </div>
        </>
      )}

      <div className="mva-status">
        {!terrainEnabled && '地形已關閉（涵蓋為理想無遮蔽狀態）'}
        {terrainEnabled && !mvaEntry && '地形：未計算'}
        {terrainEnabled && mvaEntry?.status === 'pending' && '地形：計算中…'}
        {terrainEnabled && mvaEntry?.status === 'error' && `地形計算失敗：${mvaEntry.error}`}
        {terrainEnabled && mvaEntry?.status === 'ready' && (
          <>
            地形 MVA 場已就緒（{mvaEntry.computeMs?.toFixed(0)} ms）
            {(mvaEntry.missingTiles ?? 0) > 0 && (
              <span className="warn-inline">
                　缺 {mvaEntry.missingTiles} 磚：該方向地形資料未下載，已當成海面處理
              </span>
            )}
          </>
        )}
      </div>

      <button className="danger wide" onClick={() => removeSite(site.id)}>
        刪除此陣地
      </button>
    </aside>
  );
}

function fmtAlt(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
