/**
 * 來源書目的參照完整性。
 *
 * DESIGN.md §12 的誠實性原則要求「每個 Estimate.sources 指向 sources.json」。
 * 這個規則只寫在註解裡，從來沒有東西真的檢查過它 —— 加新系統時打錯一個 id、
 * 或是從 sources.json 刪掉一筆卻忘了同步系統檔，都不會被任何工具發現，
 * 直到有人手動去對照兩份 JSON。這裡把它變成會失敗的測試。
 */

import { describe, it, expect } from 'vitest';
import sourcesJson from '../../../data/sources.json';
import threatsJson from '../../../data/threats.json';

// 用 glob 而不是逐檔 import：新增系統只需要丟一個 JSON 檔進 data/systems/，
// 不必記得回來改這份測試——那正是這個測試存在的理由（防止手動同步被忘記），
// 測試本身不該重蹈同一個覆轍。
const systemModules = import.meta.glob<{ default: unknown }>(
  '../../../data/systems/*.json',
  { eager: true },
);

interface EstimateLike {
  sources?: string[];
  confidence?: string;
  note?: string;
}

const knownIds = new Set(
  (sourcesJson as { sources: { id: string }[] }).sources.map((s) => s.id),
);

/**
 * 遞迴收集一個系統/威脅 JSON 中所有 Estimate 節點。
 *
 * 用 `nominal` + `confidence` 同時存在來判斷「這是一個 Estimate」，
 * 而不是用「有沒有 sources 陣列」—— 後者會漏掉 gun35.json 的 channels 這種
 * 完全沒寫 sources 鍵的節點，而那正是最需要被檢查的情況。
 */
function collectEstimates(node: unknown, path: string, out: { path: string; est: EstimateLike }[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectEstimates(v, `${path}[${i}]`, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.nominal === 'number' && typeof obj.confidence === 'string') {
    out.push({ path, est: obj as EstimateLike });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'sources') continue;
    collectEstimates(v, `${path}.${k}`, out);
  }
}

const FILES: [string, unknown][] = [
  ...Object.entries(systemModules).map(
    ([path, mod]) => [path.split('/').pop()!, mod.default] as [string, unknown],
  ),
  ['threats.json', threatsJson],
];

describe('來源書目參照完整性', () => {
  it('sources.json 本身至少有一筆非 terrain 的條目', () => {
    // terrain 是獨立欄位，不算在 sources 陣列裡；這裡只是確認書目不是空殼。
    expect(knownIds.size).toBeGreaterThan(0);
  });

  it('glob 確實找到了 data/systems 底下的檔案', () => {
    // 防止 glob 路徑打錯而靜默回傳空集合——那樣下面所有測試都會變成
    // 檢查了一個空清單，看起來全過但其實什麼都沒驗到。
    expect(Object.keys(systemModules).length).toBeGreaterThanOrEqual(5);
  });

  it('sources.json 每筆條目都有 id 與 url', () => {
    for (const s of (sourcesJson as { sources: { id: string; url?: string }[] }).sources) {
      expect(s.id, 'source 缺少 id').toBeTruthy();
      expect(s.url, `${s.id} 缺少 url —— 引用了卻沒給連結，等於沒有來源`).toBeTruthy();
    }
  });

  for (const [file, data] of FILES) {
    it(`${file}：每個 Estimate.sources 裡的 id 都存在於 sources.json`, () => {
      const found: { path: string; est: EstimateLike }[] = [];
      collectEstimates(data, file, found);

      const missing: string[] = [];
      for (const { path, est } of found) {
        for (const id of est.sources ?? []) {
          if (!knownIds.has(id)) missing.push(`${path}: "${id}"`);
        }
      }
      expect(missing, `以下引用的來源 id 在 sources.json 找不到：\n${missing.join('\n')}`).toEqual([]);
    });
  }

  it('confidence 為 medium 或 high 時必須有來源，或至少有 note 說明為何不需要來源', () => {
    // 兩種正當理由：(a) 有公開來源交叉印證，(b) 結構性/定義性事實
    // （例如「雙管砲共用一套射控 → 同時只能解算一個目標」），不是經驗推估，
    // 沒有『來源』可引，但必須用 note 把理由寫清楚，不能只掛一個等級就沒了。
    const violations: string[] = [];
    for (const [file, data] of FILES) {
      const found: { path: string; est: EstimateLike }[] = [];
      collectEstimates(data, file, found);
      for (const { path, est } of found) {
        const e = est as EstimateLike & { confidence?: string; note?: string };
        const hasSources = (e.sources?.length ?? 0) > 0;
        const hasReasonedNote = (e.note?.length ?? 0) > 10;
        if ((e.confidence === 'medium' || e.confidence === 'high') && !hasSources && !hasReasonedNote) {
          violations.push(`${path} (confidence=${e.confidence})`);
        }
      }
    }
    expect(
      violations,
      `以下欄位標了 medium/high，但既沒有來源也沒有 note 說明理由：\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
