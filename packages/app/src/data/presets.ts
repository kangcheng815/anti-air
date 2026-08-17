/**
 * 內建示範想定。純資料，不代表任何部署主張。
 *
 * 陣地大致地點取自 data/sources.json 的 uptogo-taiwan-bases-overview（公開報導的
 * 縣市/地名層級清單），座標由本專案自行對照公開地圖估算，系統型別與涵蓋範圍是
 * 本專案為示範分層防空概念自行指派 —— 與該報導或任何官方資料無關。
 * 見 data/presets/taiwan-bases-demo.json 內的 $comment 與 README『這不是什麼』。
 */
import type { Scenario } from '../state/store';
import taiwanBasesDemo from '../../../../data/presets/taiwan-bases-demo.json';

export interface PresetScenario {
  id: string;
  label: string;
  scenario: Scenario;
}

export const PRESET_SCENARIOS: PresetScenario[] = [
  {
    id: 'taiwan-bases-demo',
    label: '台灣基地分層防空示範（假想）',
    scenario: taiwanBasesDemo as Scenario,
  },
];
