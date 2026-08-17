import { CATALOG, TIER_LABEL, hueOf } from '../data/catalog';
import { useStore } from '../state/store';
import type { Tier } from '@anti-air/engine';

const TIERS: Tier[] = ['high', 'medium', 'short', 'point'];

export function LeftPanel() {
  const armedSystemId = useStore((s) => s.armedSystemId);
  const arm = useStore((s) => s.arm);
  const hidden = useStore((s) => s.hiddenSystemIds);
  const toggleVisible = useStore((s) => s.toggleSystemVisible);
  const sites = useStore((s) => s.sites);
  const selectedSiteId = useStore((s) => s.selectedSiteId);
  const selectSite = useStore((s) => s.selectSite);
  const tracks = useStore((s) => s.tracks);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const selectTrack = useStore((s) => s.selectTrack);

  return (
    <aside className="panel left">
      <section>
        <h2>放置陣地</h2>
        <p className="hint">
          選一個系統，然後在地圖上點擊放置。再點一次同一個系統可取消放置模式。
        </p>

        {TIERS.map((tier) => {
          const systems = CATALOG.filter((s) => s.tier === tier);
          if (systems.length === 0) return null;
          return (
            <div key={tier} className="tier-group">
              <h3>{TIER_LABEL[tier]}</h3>
              {systems.map((sys) => {
                const isHidden = hidden.has(sys.id);
                return (
                  <div key={sys.id} className="system-row">
                    <button
                      className={`system-btn ${armedSystemId === sys.id ? 'armed' : ''}`}
                      onClick={() => arm(armedSystemId === sys.id ? null : sys.id)}
                    >
                      <span
                        className="swatch"
                        style={{ background: `hsl(${hueOf(sys)}, 75%, 55%)` }}
                      />
                      <span className="system-name">{sys.name_zh}</span>
                    </button>
                    <button
                      className={`eye ${isHidden ? 'off' : ''}`}
                      onClick={() => toggleVisible(sys.id)}
                      title={isHidden ? '顯示此系統' : '隱藏此系統'}
                      aria-label={isHidden ? '顯示此系統' : '隱藏此系統'}
                    >
                      {isHidden ? '○' : '●'}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      <section className="site-list">
        <h2>陣地（{sites.length}）</h2>
        {sites.length === 0 && <p className="hint">尚未放置任何陣地。</p>}
        <ul>
          {sites.map((site) => (
            <li key={site.id}>
              <button
                className={site.id === selectedSiteId ? 'selected' : ''}
                onClick={() => selectSite(site.id)}
              >
                <span className="site-name">{site.name}</span>
                <span className="site-coord">
                  {site.lat.toFixed(3)}°N {site.lon.toFixed(3)}°E
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="site-list">
        <h2>威脅航跡（{tracks.length}）</h2>
        {tracks.length === 0 && (
          <p className="hint">
            按上方「畫航跡」在地圖上點出進襲路線。最後一點就是目標區 ——
            目標抵達它就代表防空失敗。
          </p>
        )}
        <ul>
          {tracks.map((track) => (
            <li key={track.id}>
              <button
                className={track.id === selectedTrackId ? 'selected' : ''}
                onClick={() => selectTrack(track.id)}
              >
                <span className="site-name">{track.name}</span>
                <span className="site-coord">
                  {track.count} 架次 ｜ {track.speedMps} m/s ｜{' '}
                  {track.path.length} 航點
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
