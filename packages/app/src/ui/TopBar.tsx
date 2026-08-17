import { useRef } from 'react';
import { useStore, type Scenario } from '../state/store';
import { BASEMAPS } from '../map/basemaps';
import { THREATS } from '../data/threats';
import { PRESET_SCENARIOS } from '../data/presets';
import type { LayerMode } from '../state/store';
import type { EstimateMode } from '@anti-air/engine';

const MODE_LABEL: Record<EstimateMode, string> = {
  conservative: '保守',
  nominal: '標稱',
  optimistic: '樂觀',
};

const LAYER_OPTIONS: { id: LayerMode; label: string; hint: string }[] = [
  { id: 'coverage', label: '涵蓋', hint: '各系統在此高度的可接戰範圍' },
  { id: 'depth', label: '縱深', hint: '每一格被幾套系統涵蓋（依威脅 RCS 條件化）' },
  { id: 'shadow', label: '遮蔽', hint: '選取陣地的最低可視高度色階' },
];

export function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const estimateMode = useStore((s) => s.estimateMode);
  const setEstimateMode = useStore((s) => s.setEstimateMode);
  const layerMode = useStore((s) => s.layerMode);
  const setLayerMode = useStore((s) => s.setLayerMode);
  const threatId = useStore((s) => s.threatId);
  const setThreatId = useStore((s) => s.setThreatId);
  const c2Mode = useStore((s) => s.c2Mode);
  const setC2Mode = useStore((s) => s.setC2Mode);
  const sectionDrawing = useStore((s) => s.sectionDrawing);
  const startSectionDraw = useStore((s) => s.startSectionDraw);
  const clearSection = useStore((s) => s.clearSection);
  const trackDrawing = useStore((s) => s.trackDrawing);
  const startTrackDraw = useStore((s) => s.startTrackDraw);
  const finishTrackDraw = useStore((s) => s.finishTrackDraw);
  const timelineOpen = useStore((s) => s.timelineOpen);
  const setTimelineOpen = useStore((s) => s.setTimelineOpen);
  const trackCount = useStore((s) => s.tracks.length);
  const basemapId = useStore((s) => s.basemapId);
  const setBasemap = useStore((s) => s.setBasemap);
  const clearAll = useStore((s) => s.clearAll);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const setTerrainEnabled = useStore((s) => s.setTerrainEnabled);
  const terrainAvailable = useStore((s) => s.terrainManifest !== null);

  function save() {
    const scenario = useStore.getState().exportScenario();
    const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'anti-air-scenario.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function load(file: File) {
    file.text().then((text) => {
      try {
        useStore.getState().importScenario(JSON.parse(text) as Scenario);
      } catch {
        alert('想定檔解析失敗：不是有效的 JSON。');
      }
    });
  }

  function loadPreset(scenario: Scenario) {
    useStore.getState().importScenario(scenario);
  }

  return (
    <header className="topbar">
      <div className="brand">
        ANTI-AIR
        <span className="disclaimer">所有數值皆為公開推估，陣地位置為使用者自行放置的假想示例</span>
      </div>

      <div className="topbar-controls">
        <div className="seg" role="group" aria-label="估計模式">
          {(['conservative', 'nominal', 'optimistic'] as EstimateMode[]).map((m) => (
            <button
              key={m}
              className={estimateMode === m ? 'active' : ''}
              onClick={() => setEstimateMode(m)}
              title="切換參數的保守／標稱／樂觀端點"
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        <div className="seg" role="group" aria-label="圖層">
          {LAYER_OPTIONS.map((o) => (
            <button
              key={o.id}
              className={layerMode === o.id ? 'active' : ''}
              onClick={() => setLayerMode(o.id)}
              title={o.hint}
            >
              {o.label}
            </button>
          ))}
        </div>

        <select
          value={threatId}
          onChange={(e) => setThreatId(e.target.value)}
          title="威脅的 RCS 決定所有感測器的偵測距離"
        >
          {THREATS.map((t) => (
            <option key={t.id} value={t.id}>
              威脅：{t.name_zh}（RCS {t.rcs_m2.nominal} m²）
            </option>
          ))}
        </select>

        <select
          value={c2Mode}
          onChange={(e) => setC2Mode(e.target.value as typeof c2Mode)}
          title="感測器—射手分離：射手能否使用其他陣地的軌跡"
        >
          <option value="shared">C2：全島共享軌跡</option>
          <option value="independent">C2：各自為政</option>
        </select>

        <label
          className={`check ${terrainAvailable ? '' : 'disabled'}`}
          title={
            terrainAvailable
              ? '關掉可直接對比「不算地形」的理想涵蓋'
              : '尚未下載地形資料，請執行 node tools/fetch-terrain.mjs'
          }
        >
          <input
            type="checkbox"
            checked={terrainEnabled && terrainAvailable}
            disabled={!terrainAvailable}
            onChange={(e) => setTerrainEnabled(e.target.checked)}
          />
          地形
        </label>

        <button
          className={sectionDrawing ? 'active-btn' : ''}
          onClick={sectionDrawing ? clearSection : startSectionDraw}
          title="在地圖上點兩下畫一條線，看側視剖面"
        >
          {sectionDrawing ? '取消剖面' : '畫剖面'}
        </button>

        <button
          className={trackDrawing ? 'active-btn' : ''}
          onClick={trackDrawing ? finishTrackDraw : startTrackDraw}
          title="在地圖上點出進襲路線，雙擊或按此鈕結束。終點即目標區。"
        >
          {trackDrawing ? '完成航跡' : '畫航跡'}
        </button>

        <button
          className={timelineOpen ? 'active-btn' : ''}
          onClick={() => setTimelineOpen(!timelineOpen)}
          title="接戰時間軸：射擊機會、通道飽和、漏網原因"
          disabled={trackCount === 0}
        >
          時間軸{trackCount > 0 ? `（${trackCount}）` : ''}
        </button>

        <select value={basemapId} onChange={(e) => setBasemap(e.target.value)}>
          {BASEMAPS.map((b) => (
            <option key={b.id} value={b.id}>
              底圖：{b.label}
            </option>
          ))}
        </select>

        <select
          value=""
          onChange={(e) => {
            const preset = PRESET_SCENARIOS.find((p) => p.id === e.target.value);
            if (preset) loadPreset(preset.scenario);
          }}
          title="內建示範想定：陣地位置參考公開報導提及的營區大致地點，系統指派為本專案自行示範分層防空概念，非部署主張"
        >
          <option value="" disabled>
            示範想定…
          </option>
          {PRESET_SCENARIOS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <button onClick={save}>存檔</button>
        <button onClick={() => fileRef.current?.click()}>讀檔</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) load(f);
            e.target.value = '';
          }}
        />
        <button className="danger" onClick={clearAll}>
          清空
        </button>
      </div>
    </header>
  );
}
