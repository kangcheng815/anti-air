import { useStore } from '../state/store';

/**
 * 高度滑桿 —— 這是整個工具的主互動。
 *
 * 用對數刻度：0–1 km 之間的變化最劇烈（地平線在此區間咬得最兇），
 * 線性刻度會把這段擠成滑桿最左邊的一小截，等於把重點藏起來。
 */
const ALT_MIN = 50;
const ALT_MAX = 20_000;
const LOG_SPAN = Math.log(ALT_MAX / ALT_MIN);

const sliderToAlt = (t: number) => ALT_MIN * Math.exp(t * LOG_SPAN);
const altToSlider = (m: number) => Math.log(m / ALT_MIN) / LOG_SPAN;

const PRESETS: { label: string; m: number; why: string }[] = [
  { label: '100 m', m: 100, why: '掠海巡弋飛彈' },
  { label: '500 m', m: 500, why: '低空突防' },
  { label: '3 km', m: 3000, why: '一般攻擊機' },
  { label: '10 km', m: 10_000, why: '高空戰機' },
  { label: '15 km', m: 15_000, why: '彈道飛彈中段' },
];

export function BottomBar() {
  const altitudeM = useStore((s) => s.altitudeM);
  const setAltitude = useStore((s) => s.setAltitude);
  const sites = useStore((s) => s.sites);
  const terrainChecked = useStore((s) => s.terrainChecked);
  const terrainAvailable = useStore((s) => s.terrainManifest !== null);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const manifest = useStore((s) => s.terrainManifest);
  const pending = useStore(
    (s) => Object.values(s.mva).filter((e) => e.status === 'pending').length,
  );

  const terrainNote = !terrainChecked
    ? '檢查地形資料…'
    : !terrainAvailable
      ? '無地形資料 — 執行 node tools/fetch-terrain.mjs 後重整'
      : !terrainEnabled
        ? '地形遮蔽已關閉'
        : pending > 0
          ? `地形計算中（${pending}）…`
          : `地形 ${manifest?.groundResolutionM ?? '?'} m/px`;

  return (
    <footer className="bottombar">
      <div className="alt-readout">
        <span className="alt-value">
          {altitudeM < 1000
            ? `${Math.round(altitudeM)} m`
            : `${(altitudeM / 1000).toFixed(1)} km`}
        </span>
        <span className="alt-caption">目標高度</span>
      </div>

      <input
        className="alt-slider"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={altToSlider(altitudeM)}
        onChange={(e) => setAltitude(sliderToAlt(Number(e.target.value)))}
        aria-label="目標高度"
      />

      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.m}
            className={Math.abs(altitudeM - p.m) < 1 ? 'active' : ''}
            onClick={() => setAltitude(p.m)}
            title={p.why}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="phase-note">
        {terrainNote}
        {sites.length > 0 && ` ｜ ${sites.length} 個陣地`}
      </div>
    </footer>
  );
}
