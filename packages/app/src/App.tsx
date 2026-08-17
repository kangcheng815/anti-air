import { MapView } from './map/MapView';
import { TopBar } from './ui/TopBar';
import { LeftPanel } from './ui/LeftPanel';
import { RightPanel } from './ui/RightPanel';
import { BottomBar } from './ui/BottomBar';
import { useTerrainSync } from './terrain/useTerrainSync';
import { CrossSection } from './analysis/CrossSection';
import { TimelinePanel } from './analysis/TimelinePanel';

export function App() {
  useTerrainSync();

  return (
    <div className="app">
      <TopBar />
      <div className="body">
        <LeftPanel />
        <div className="center">
          <MapView />
          {/* 剖面與時間軸共用地圖下方同一塊空間，store 保證兩者互斥 */}
          <CrossSection />
          <TimelinePanel />
        </div>
        <RightPanel />
      </div>
      <BottomBar />
    </div>
  );
}
