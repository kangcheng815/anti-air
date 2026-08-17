import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useStore } from '../state/store';
import { basemapById, TAIWAN_VIEW } from './basemaps';
import { buildCoverageGeoJSON, buildSiteGeoJSON } from './coverage';
import { renderShadow, SHADOW_BANDS } from './shadowLayer';
import { renderDepth, DEPTH_BANDS } from '../analysis/depthLayer';
import { toSiteStates } from '../analysis/siteStates';
import { THREAT_BY_ID } from '../data/threats';
import {
  buildContactGeoJSON,
  buildMissileGeoJSON,
  buildTrackGeoJSON,
  buildTrackNodeGeoJSON,
} from './tracks';
import { snapshotContacts, snapshotMissiles, useTimelineRun } from '../analysis/timelineModel';

const COVERAGE_SRC = 'coverage';
const SITES_SRC = 'sites';
const SITE_LAYER = 'site-circle';
const SHADOW_SRC = 'terrain-shadow';
const SHADOW_LAYER = 'terrain-shadow-layer';
const DEPTH_SRC = 'depth';
const DEPTH_LAYER = 'depth-layer';
const SECTION_SRC = 'section';
const TRACK_SRC = 'tracks';
const TRACK_NODE_SRC = 'track-nodes';
const TRACK_LAYER = 'track-line';
const CONTACT_SRC = 'contacts';
const CONTACT_LAYER = 'contact-circle';
const MISSILE_SRC = 'missiles';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * 安裝自訂圖層。切換底圖樣式會清空所有非樣式圖層，所以每次 style 載入後都要重跑。
 */
function installLayers(map: MLMap): boolean {
  if (map.getSource(COVERAGE_SRC)) return false;

  map.addSource(COVERAGE_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(SITES_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(SECTION_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(TRACK_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(TRACK_NODE_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(MISSILE_SRC, { type: 'geojson', data: EMPTY });
  map.addSource(CONTACT_SRC, { type: 'geojson', data: EMPTY });

  map.addLayer({
    id: 'coverage-fill',
    type: 'fill',
    source: COVERAGE_SRC,
    paint: {
      'fill-color': ['get', 'fill'],
      // 透明度低、彼此疊加 —— 重疊處自然變深，這就是最原始的縱深視覺。
      // Phase 3 會換成明確的縱深熱圖圖層。
      'fill-opacity': 0.2,
    },
  });

  map.addLayer({
    id: 'coverage-line',
    type: 'line',
    source: COVERAGE_SRC,
    paint: {
      'line-color': ['get', 'stroke'],
      'line-width': 1.4,
      'line-opacity': 0.9,
    },
  });

  map.addLayer({
    id: 'section-line',
    type: 'line',
    source: SECTION_SRC,
    paint: {
      'line-color': '#111',
      'line-width': 2.5,
      'line-dasharray': [2, 1.5],
    },
  });

  // --- Phase 4：航跡與時間切片 ---
  //
  // 排在陣地圖層之前，讓陣地標記永遠壓在最上面 ——
  // 航跡是威脅，陣地是使用者正在編輯的東西，後者不該被前者蓋住。
  map.addLayer({
    id: TRACK_LAYER,
    type: 'line',
    source: TRACK_SRC,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#7b1e1e',
      'line-width': ['case', ['get', 'selected'], 3.2, 1.8],
      'line-opacity': 0.85,
      'line-dasharray': [3, 2],
    },
  });

  map.addLayer({
    id: 'track-node',
    type: 'circle',
    source: TRACK_NODE_SRC,
    paint: {
      // 起點空心、終點實心：終點是目標區，是這條航跡真正要保護的東西。
      'circle-radius': ['case', ['==', ['get', 'role'], 'end'], 5.5, 3.5],
      'circle-color': ['case', ['==', ['get', 'role'], 'end'], '#7b1e1e', '#ffffff'],
      'circle-stroke-width': 1.6,
      'circle-stroke-color': '#7b1e1e',
    },
  });

  map.addLayer({
    id: 'missile-line',
    type: 'line',
    source: MISSILE_SRC,
    paint: { 'line-color': '#1f6feb', 'line-width': 1.6, 'line-opacity': 0.9 },
  });

  map.addLayer({
    id: CONTACT_LAYER,
    type: 'circle',
    source: CONTACT_SRC,
    paint: {
      'circle-radius': 5,
      'circle-color': [
        'match',
        ['get', 'state'],
        'leaked',
        '#c0392b', // 全程沒被接戰 —— 這一顆才是重點
        'engaged',
        '#3d4c5c',
        '#8a919c',
      ],
      'circle-stroke-width': 1.6,
      'circle-stroke-color': '#fff',
    },
  });

  map.addLayer({
    id: SITE_LAYER,
    type: 'circle',
    source: SITES_SRC,
    paint: {
      'circle-radius': 6,
      'circle-color': ['get', 'stroke'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
      'circle-opacity': ['case', ['==', ['get', 'status'], 'down'], 0.35, 1],
    },
  });

  map.addLayer({
    id: 'site-label',
    type: 'symbol',
    source: SITES_SRC,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#1a1a1a',
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  });

  return true;
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const styleAppliedRef = useRef(false);
  /**
   * 每次樣式套用完成就 +1。資料 effect 依賴它，確保切換底圖後
   * 一定是在圖層重建之後才灌資料，而不是灌進一個剛被清空的 source。
   */
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [banner, setBanner] = useState<{ kind: 'error' | 'warn'; text: string } | null>(null);
  const [depthStats, setDepthStats] = useState<{ histogram: number[]; computeMs: number } | null>(
    null,
  );

  const sites = useStore((s) => s.sites);
  const hidden = useStore((s) => s.hiddenSystemIds);
  const altitudeM = useStore((s) => s.altitudeM);
  const estimateMode = useStore((s) => s.estimateMode);
  const aspect = useStore((s) => s.aspect);
  const layerMode = useStore((s) => s.layerMode);
  const threatId = useStore((s) => s.threatId);
  const c2Mode = useStore((s) => s.c2Mode);
  const sectionLine = useStore((s) => s.sectionLine);
  const sectionDrawing = useStore((s) => s.sectionDrawing);
  const basemapId = useStore((s) => s.basemapId);
  const selectedSiteId = useStore((s) => s.selectedSiteId);
  const armedSystemId = useStore((s) => s.armedSystemId);
  const mvaBySite = useStore((s) => s.mva);
  const terrainEnabled = useStore((s) => s.terrainEnabled);
  const tracks = useStore((s) => s.tracks);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const trackDrawing = useStore((s) => s.trackDrawing);
  const timelineOpen = useStore((s) => s.timelineOpen);
  const simTimeS = useStore((s) => s.simTimeS);

  // --- 初始化（只跑一次）---
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapById(useStore.getState().basemapId).style,
      center: TAIWAN_VIEW.center,
      zoom: TAIWAN_VIEW.zoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    // 開發期把 map 掛到 window，方便在瀏覽器主控台檢查圖層與圖徵。
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: MLMap }).__map = map;
    }

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-right');

    // 圖層安裝不能綁在 'load' 上。'load' 要等到圖磚也就緒才觸發，
    // 而圖磚在離線或受限網路下可能永遠不會來 —— 那時樣式其實已經套好了，
    // 只是我們的涵蓋圖層永遠不會被裝上去，整個工具靜默失效。
    // 改成樣式一套好就裝，圖磚載不載得到跟涵蓋計算無關。
    // styledata 會頻繁觸發，只有「這次真的裝了圖層」才遞增 epoch，
    // 否則每個 styledata 都會白白重算一次全部涵蓋多邊形。
    const install = () => {
      if (!map.getStyle()?.layers) return;
      styleAppliedRef.current = true;
      if (installLayers(map)) setStyleEpoch((n) => n + 1);
    };

    map.on('style.load', install);
    map.on('styledata', install);

    map.on('error', (e) => {
      const msg = String(e.error?.message ?? '');
      if (!styleAppliedRef.current) {
        setBanner({ kind: 'error', text: `底圖樣式載入失敗：${msg || '未知錯誤'}` });
      } else {
        // 樣式已套用、只是圖磚拉不到。涵蓋計算完全不受影響，據實說明即可。
        setBanner({
          kind: 'warn',
          text: '底圖圖磚無法載入（網路或圖磚服務問題）。涵蓋計算與陣地編輯不受影響。',
        });
      }
    });

    // 點擊：先判斷是否點到既有陣地，否則若已選定系統就放置新陣地。
    // 用 getState() 讀取當下狀態，避免閉包抓到舊值。
    map.on('click', (e) => {
      const state = useStore.getState();

      // 畫剖面線時，點擊一律是取點，不要順手放置陣地或改變選取。
      if (state.sectionDrawing) {
        state.addSectionPoint(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      // 畫航跡時同理：一路取點，直到使用者按下「完成」或雙擊。
      if (state.trackDrawing) {
        state.addTrackPoint(e.lngLat.lng, e.lngLat.lat);
        return;
      }

      const hits = map.queryRenderedFeatures(e.point, { layers: [SITE_LAYER] });
      if (hits.length > 0) {
        state.selectSite(String(hits[0].properties?.siteId));
        return;
      }
      const trackHits = map.queryRenderedFeatures(e.point, { layers: [TRACK_LAYER] });
      if (trackHits.length > 0) {
        state.selectTrack(String(trackHits[0].properties?.trackId));
        return;
      }
      if (state.armedSystemId) state.placeSite(e.lngLat.lng, e.lngLat.lat);
      else state.selectSite(null);
    });

    // 雙擊結束航跡。MapLibre 的雙擊預設是放大，畫航跡時要擋掉，
    // 否則最後一點會連帶把地圖縮放掉。
    map.on('dblclick', (e) => {
      if (!useStore.getState().trackDrawing) return;
      e.preventDefault();
      useStore.getState().finishTrackDraw();
    });

    // 畫剖面線時即時預覽第二點。
    map.on('mousemove', (e) => {
      const state = useStore.getState();
      if (!state.sectionDrawing || !state.sectionLine) return;
      useStore.setState({
        sectionLine: [state.sectionLine[0], [e.lngLat.lng, e.lngLat.lat]],
      });
    });

    // 強制讓 MapLibre 的畫布尺寸跟上容器。
    //
    // 不能只依賴 MapLibre 自己的 trackResize：實測過畫布卡在預設的 400×24，
    // 而容器是 720×577 —— CSS 把 24 px 高的內容拉伸到 577 px，畫面就是一坨糊掉的色塊。
    // 成因是建構當下容器還沒拿到樣式（Vite 在 dev 模式非同步注入 CSS），
    // 之後又沒有任何事件把它救回來。
    //
    // 另一個必須自己觀察的理由：垂直剖面面板開合會讓地圖高度變動 240 px。
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    // 樣式套用可能晚於本 effect，補一次非 rAF 的延後 resize。
    const resizeTimer = window.setTimeout(() => map.resize(), 0);

    map.on('mouseenter', SITE_LAYER, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', SITE_LAYER, () => {
      map.getCanvas().style.cursor = useStore.getState().armedSystemId ? 'crosshair' : '';
    });

    return () => {
      resizeObserver.disconnect();
      window.clearTimeout(resizeTimer);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // --- 底圖切換 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    setBanner(null);
    styleAppliedRef.current = false;
    map.setStyle(basemapById(basemapId).style);
    // 這裡刻意不依賴 styleEpoch：只有 basemapId 變才換樣式，
    // 否則 install 造成的 epoch 遞增會觸發無限換樣式迴圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapId]);

  // --- 資料更新 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;

    const coverage = map.getSource(COVERAGE_SRC) as GeoJSONSource | undefined;
    const siteSrc = map.getSource(SITES_SRC) as GeoJSONSource | undefined;
    if (!coverage || !siteSrc) return;

    coverage.setData(
      layerMode === 'coverage'
        ? buildCoverageGeoJSON(sites, hidden, {
            altitudeM,
            estimateMode,
            aspect,
            mvaBySite,
            terrainEnabled,
          })
        : EMPTY,
    );
    siteSrc.setData(buildSiteGeoJSON(sites.filter((s) => !hidden.has(s.systemId))));
  }, [
    styleEpoch,
    sites,
    hidden,
    altitudeM,
    estimateMode,
    aspect,
    layerMode,
    mvaBySite,
    terrainEnabled,
  ]);

  // --- 航跡幾何 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    const line = map.getSource(TRACK_SRC) as GeoJSONSource | undefined;
    const node = map.getSource(TRACK_NODE_SRC) as GeoJSONSource | undefined;
    if (!line || !node) return;
    line.setData(buildTrackGeoJSON(tracks, selectedTrackId));
    node.setData(buildTrackNodeGeoJSON(tracks, selectedTrackId));
  }, [styleEpoch, tracks, selectedTrackId]);

  // --- 時間切片：T+t 這一刻的目標與在空中的飛彈 ---
  //
  // 模擬本身依賴陣地、航跡、估計模式；時間游標只挑切片，不重跑模擬。
  // 這跟 Phase 2 的「MVA 場算一次、所有高度切片共用」是同一個原則 ——
  // 否則拖時間軸會變成每一格重跑一次離散事件模擬。
  const timelineRun = useTimelineRun();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    const contactSrc = map.getSource(CONTACT_SRC) as GeoJSONSource | undefined;
    const missileSrc = map.getSource(MISSILE_SRC) as GeoJSONSource | undefined;
    if (!contactSrc || !missileSrc) return;

    if (!timelineRun) {
      contactSrc.setData(EMPTY);
      missileSrc.setData(EMPTY);
      return;
    }
    contactSrc.setData(buildContactGeoJSON(snapshotContacts(timelineRun, simTimeS)));
    missileSrc.setData(buildMissileGeoJSON(snapshotMissiles(timelineRun, simTimeS)));
  }, [styleEpoch, timelineRun, simTimeS]);

  // --- 剖面面板開合會讓地圖高度變動 240 px ---
  //
  // ResizeObserver 理論上會處理，但它的回呼綁在畫面更新生命週期上，
  // 不保證即時（實測在不合成畫面的環境下完全不會送出）。
  // 這是我們自己控制的狀態變化，直接明確 resize，不要依賴非同步觀察器。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    map.resize();
  }, [styleEpoch, sectionLine !== null, sectionDrawing, timelineOpen]);

  // --- 縱深熱圖 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;

    if (map.getLayer(DEPTH_LAYER)) map.removeLayer(DEPTH_LAYER);
    if (map.getSource(DEPTH_SRC)) map.removeSource(DEPTH_SRC);
    setDepthStats(null);

    if (layerMode !== 'depth') return;
    const threat = THREAT_BY_ID.get(threatId);
    if (!threat) return;

    const states = toSiteStates(
      sites.filter((s) => !hidden.has(s.systemId)),
      mvaBySite,
      terrainEnabled,
    );
    const result = renderDepth({
      sites: states,
      threat,
      altitudeM,
      mode: estimateMode,
      aspect,
      c2Mode,
    });
    if (!result) return;

    map.addSource(DEPTH_SRC, {
      type: 'image',
      url: result.url,
      coordinates: result.coordinates,
    });
    map.addLayer(
      { id: DEPTH_LAYER, type: 'raster', source: DEPTH_SRC, paint: { 'raster-opacity': 1 } },
      map.getLayer(SITE_LAYER) ? SITE_LAYER : undefined,
    );
    setDepthStats({ histogram: result.histogram, computeMs: result.computeMs });
  }, [
    styleEpoch,
    layerMode,
    threatId,
    c2Mode,
    sites,
    hidden,
    mvaBySite,
    terrainEnabled,
    altitudeM,
    estimateMode,
    aspect,
  ]);

  // --- 剖面線 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    const src = map.getSource(SECTION_SRC) as GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      sectionLine
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sectionLine } },
            ],
          }
        : EMPTY,
    );
  }, [styleEpoch, sectionLine]);

  // --- 地形遮蔽圖層（只畫選取中的陣地）---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;

    // 每次都整個拆掉重建。CanvasSource 沒有乾淨的「換內容」API，
    // 而重建一次約 30 ms，遠低於使用者能察覺的門檻。
    if (map.getLayer(SHADOW_LAYER)) map.removeLayer(SHADOW_LAYER);
    if (map.getSource(SHADOW_SRC)) map.removeSource(SHADOW_SRC);

    if (layerMode !== 'shadow' || !selectedSiteId) return;
    const entry = mvaBySite[selectedSiteId];
    if (entry?.status !== 'ready' || !entry.field) return;

    const { url, coordinates } = renderShadow(entry.field);
    map.addSource(SHADOW_SRC, { type: 'image', url, coordinates });
    map.addLayer(
      { id: SHADOW_LAYER, type: 'raster', source: SHADOW_SRC, paint: { 'raster-opacity': 1 } },
      map.getLayer('coverage-fill') ? 'coverage-fill' : undefined,
    );
  }, [styleEpoch, layerMode, selectedSiteId, mvaBySite]);

  // --- 選取強調 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0 || !map.getLayer('coverage-line')) return;

    map.setPaintProperty('coverage-line', 'line-width', [
      'case',
      ['==', ['get', 'siteId'], selectedSiteId ?? '__none__'],
      3.2,
      1.4,
    ]);
    map.setPaintProperty(SITE_LAYER, 'circle-radius', [
      'case',
      ['==', ['get', 'siteId'], selectedSiteId ?? '__none__'],
      9,
      6,
    ]);
  }, [styleEpoch, selectedSiteId]);

  // --- 選到視野外的陣地時才移動地圖（避免每次點選都亂跳）---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0 || !selectedSiteId) return;
    const site = useStore.getState().sites.find((s) => s.id === selectedSiteId);
    if (!site) return;
    if (!map.getBounds().contains([site.lon, site.lat])) {
      map.easeTo({ center: [site.lon, site.lat], duration: 500 });
    }
  }, [styleEpoch, selectedSiteId]);

  // --- 游標 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleEpoch === 0) return;
    map.getCanvas().style.cursor =
      sectionDrawing || trackDrawing || armedSystemId ? 'crosshair' : '';
    // 畫航跡靠雙擊收尾，此時不能讓雙擊同時把地圖放大。
    if (trackDrawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [styleEpoch, armedSystemId, sectionDrawing, trackDrawing]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      {banner && <div className={`map-banner ${banner.kind}`}>{banner.text}</div>}
      {layerMode === 'shadow' && selectedSiteId && (
        <div className="legend">
          <strong>最低可視高度</strong>
          <span className="legend-sub">目標要飛多高才會被本陣地看到</span>
          {SHADOW_BANDS.map((b) => (
            <div key={b.label} className="legend-row">
              <span
                className="legend-swatch"
                style={{ background: `rgb(${b.color[0]},${b.color[1]},${b.color[2]})` }}
              />
              {b.label}
            </div>
          ))}
        </div>
      )}

      {layerMode === 'depth' && depthStats && (
        <div className="legend">
          <strong>接戰縱深</strong>
          <span className="legend-sub">此高度、此威脅下有幾套系統能接戰</span>
          {DEPTH_BANDS.map((b, i) => {
            const total = depthStats.histogram.reduce((a, c) => a + c, 0) || 1;
            return (
              <div key={b.label} className="legend-row">
                <span
                  className="legend-swatch"
                  style={{ background: `rgb(${b.color[0]},${b.color[1]},${b.color[2]})` }}
                />
                {b.label}
                <span className="legend-pct">
                  {((depthStats.histogram[i] / total) * 100).toFixed(0)}%
                </span>
              </div>
            );
          })}
          <span className="legend-sub legend-foot">
            僅在運動學射程聯集內著色 ｜ {depthStats.computeMs.toFixed(0)} ms
          </span>
        </div>
      )}
    </div>
  );
}
