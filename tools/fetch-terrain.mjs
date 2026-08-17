#!/usr/bin/env node
/**
 * 下載 Terrarium 編碼的地形圖磚到本地，供 app 離線取用。
 *
 * 為什麼要下載到本地而不是執行期直接連外：
 *   1. MVA 計算每個陣地要取樣 ~36 萬點，等網路回應會讓「拖曳陣地即時重算」破功。
 *   2. 圖磚服務可能被防火牆或沙箱擋掉（本專案開發時就遇到）。
 *   3. 分析結果要可重現：地形資料應該是釘住的版本，不是每次跑都可能變的遠端狀態。
 *
 * 資料來源：AWS Open Data「Terrain Tiles」，Terrarium PNG 編碼。
 *   elevation_m = (R * 256 + G + B / 256) - 32768
 * 底層資料為 SRTM / NED / 各國公開 DEM 的合併產物，公有領域或開放授權。
 * 詳見 https://registry.opendata.aws/terrain-tiles/
 *
 * 用法：
 *   node tools/fetch-terrain.mjs --dry-run
 *   node tools/fetch-terrain.mjs --zoom 11
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ATTRIBUTION =
  'Terrain Tiles (AWS Open Data) — SRTM / NED 等公開 DEM 之合併產物';

/** 台灣本島 + 澎湖 + 周邊海域。100 km 涵蓋圈外緣是海，不需再往外擴。 */
const DEFAULT_BBOX = { west: 119.0, south: 21.4, east: 122.6, north: 25.7 };

const args = parseArgs(process.argv.slice(2));
const zoom = Number(args.zoom ?? 11);
const bbox = args.bbox ? parseBbox(args.bbox) : DEFAULT_BBOX;
const outDir = args.out ?? join(ROOT, 'packages/app/public/terrain');
const concurrency = Number(args.concurrency ?? 8);

const range = tileRange(bbox, zoom);
const tiles = [];
for (let x = range.minX; x <= range.maxX; x++) {
  for (let y = range.minY; y <= range.maxY; y++) tiles.push({ x, y });
}

const groundResM = (40075016.686 * Math.cos((23.5 * Math.PI) / 180)) / (256 * 2 ** zoom);

console.log(`縮放層級 z${zoom}   地面解析度 ≈ ${groundResM.toFixed(1)} m/px（緯度 23.5°）`);
console.log(`範圍 x ${range.minX}–${range.maxX}, y ${range.minY}–${range.maxY}`);
console.log(`圖磚數 ${tiles.length}   預估大小 ≈ ${((tiles.length * 110) / 1024).toFixed(1)} MB`);

if (args['dry-run']) {
  console.log('\n（dry-run，未下載）');
  process.exit(0);
}

let done = 0;
let downloaded = 0;
let skipped = 0;
let failed = 0;

await runPool(tiles, concurrency, async ({ x, y }) => {
  const path = join(outDir, String(zoom), String(x), `${y}.png`);
  if (await exists(path)) {
    skipped++;
  } else {
    try {
      const res = await fetch(`${TILE_URL}/${zoom}/${x}/${y}.png`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buf);
      downloaded++;
    } catch (e) {
      failed++;
      console.error(`  失敗 ${zoom}/${x}/${y}: ${e.message}`);
    }
  }
  done++;
  if (done % 50 === 0 || done === tiles.length) {
    process.stdout.write(`\r  ${done}/${tiles.length}  下載 ${downloaded} 略過 ${skipped} 失敗 ${failed}`);
  }
});

console.log();

const manifest = {
  source: TILE_URL,
  attribution: ATTRIBUTION,
  encoding: 'terrarium',
  zoom,
  bbox,
  tileRange: range,
  tileSize: 256,
  groundResolutionM: Number(groundResM.toFixed(1)),
  fetchedAt: new Date().toISOString(),
  note: '海域為測深值（負數），使用時一律夾到 0：雷達看到的是海面，不是海床。',
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`完成。manifest 寫入 ${join(outDir, 'manifest.json')}`);

// ---------------------------------------------------------------- helpers

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function parseBbox(s) {
  const [west, south, east, north] = s.split(',').map(Number);
  return { west, south, east, north };
}

/** Web Mercator 圖磚索引。y 由北往南遞增。 */
function lonToX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function tileRange(b, z) {
  return {
    minX: lonToX(b.west, z),
    maxX: lonToX(b.east, z),
    minY: latToY(b.north, z),
    maxY: latToY(b.south, z),
  };
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function runPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
