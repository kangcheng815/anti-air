/**
 * 讓 canvas 的繪圖緩衝區跟上它的 CSS 尺寸。
 *
 * 這是 DESIGN.md §10.5 坑 2 的同一個問題，換到 2D canvas 上：
 * 繪製 effect 依賴的是資料，不是尺寸，所以視窗變大或面板開合之後
 * `canvas.width` 還停在舊值，畫面被 CSS 拉伸成錯誤的長寬比。
 * 實測過 755×185 的元素上掛著 652×237 的緩衝區。
 *
 * 回傳一個尺寸變更計數器，把它放進繪製 effect 的相依陣列即可。
 *
 * 為什麼同時掛 ResizeObserver 與 window resize：ResizeObserver 的回呼
 * 綁在畫面更新生命週期上，在不合成畫面的環境下實測完全不會送出。
 * 兩者都掛，靠尺寸字串去重，重複觸發不會造成多餘的重繪。
 */

import { useEffect, useState, type RefObject } from 'react';

export function useCanvasSize(ref: RefObject<HTMLCanvasElement | null>): number {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last = '';
    const check = () => {
      const key = `${el.clientWidth}x${el.clientHeight}`;
      if (key === last) return;
      last = key;
      setEpoch((n) => n + 1);
    };

    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [ref]);

  return epoch;
}
