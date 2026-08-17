import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './state/store';
import './styles.css';

// 開發期把 store 掛到 window，與 MapView 掛 __map 是同一個用途：
// 在主控台直接組出想定、直接讀模擬結果，不必靠一連串地圖點擊去湊狀態。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
