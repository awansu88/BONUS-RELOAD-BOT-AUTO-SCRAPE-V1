import React, { useEffect, useState } from 'react';
import { Toaster } from 'react-hot-toast';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import MonitoringPage from './pages/MonitoringPage';
import FilterProfilesPage from './pages/FilterProfilesPage';
import GoogleSheetsPage from './pages/GoogleSheetsPage';
import SettingsPage from './pages/SettingsPage';
import LogsPage from './pages/LogsPage';
import AboutPage from './pages/AboutPage';
import MaintenancePage from './pages/MaintenancePage';
import { useMonitoringStore } from './store/monitoring-store';

type Page = 'monitoring' | 'filters' | 'google' | 'settings' | 'logs' | 'about' | 'maintenance';

const PAGE_KEY = 'ldm.ui.lastActivePage';
const VALID_PAGES: Page[] = ['monitoring', 'filters', 'google', 'settings', 'logs', 'about', 'maintenance'];

function loadInitialPage(): Page {
  try {
    const stored = localStorage.getItem(PAGE_KEY);
    if (stored && (VALID_PAGES as string[]).includes(stored)) return stored as Page;
  } catch { /* localStorage may be unavailable — fall back */ }
  return 'monitoring';
}

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<Page>(loadInitialPage);
  const { setMonitoringState, setIsMonitoring, setExportStats } = useMonitoringStore();

  useEffect(() => {
    if (window.electron) {
      window.electron.onStateChange((state) => {
        setMonitoringState(state as any);
        if (state === 'PAUSED' || state === 'IDLE') setIsMonitoring(false);
      });
      window.electron.onStatsUpdate((stats) => setExportStats(stats));
    }
  }, []);

  // Persist last active page across restarts (chromium localStorage in userData).
  useEffect(() => {
    try { localStorage.setItem(PAGE_KEY, currentPage); } catch { /* ignore */ }
  }, [currentPage]);

  const renderPage = () => {
    switch (currentPage) {
      case 'monitoring': return <MonitoringPage />;
      case 'filters':    return <FilterProfilesPage />;
      case 'google':     return <GoogleSheetsPage />;
      case 'settings':   return <SettingsPage />;
      case 'logs':        return <LogsPage />;
      case 'about':       return <AboutPage />;
      case 'maintenance': return <MaintenancePage />;
      default:            return <MonitoringPage />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: { background: '#1c1e21', color: '#e6e8ec', border: '1px solid #2b2f36', fontSize: '13px' }
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="flex-1 overflow-auto p-4">
          {renderPage()}
        </main>
      </div>

      <StatusBar />
    </div>
  );
};

export default App;
