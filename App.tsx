
import React, { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ActivityLog } from './components/ActivityLog';
import { ClientProfilePage } from './pages/ClientProfilePage';
import { LoginPage } from './pages/LoginPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { LayoutDashboard, Briefcase, Activity, Settings, User, Shield } from 'lucide-react';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';

// Map URL paths to page IDs for nav highlighting
const pathToPageId: Record<string, string> = {
  '/': 'dashboard',
  '/jobs': 'jobs',
  '/activity': 'activity',
  '/settings': 'settings',
  '/profile': 'profile',
  '/admin': 'admin',
};

// Inner App component
const MainLayout: React.FC = () => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { t } = useLanguage();
  const { user, role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Auth Guard
  if (!user) {
    return <LoginPage />;
  }

  // Determine current page from URL for nav highlighting
  const currentPage = location.pathname.startsWith('/jobs')
    ? 'jobs'
    : (pathToPageId[location.pathname] || 'dashboard');

  const navItems = [
    { id: 'dashboard', label: t('nav.dashboard'), icon: LayoutDashboard, path: '/' },
    { id: 'jobs', label: t('nav.jobs'), icon: Briefcase, path: '/jobs' },
    { id: 'activity', label: t('nav.activity'), icon: Activity, path: '/activity' },
    { id: 'settings', label: t('nav.settings'), icon: Settings, path: '/settings' },
    { id: 'profile', label: t('nav.account'), icon: User, path: '/profile' },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-24 md:pb-8">
      <Sidebar
        currentPage={currentPage}
        onNavigate={(page: string) => {
          const item = navItems.find(n => n.id === page);
          navigate(item ? item.path : `/${page}`);
        }}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />

      <main
        className={`transition-all duration-300 ease-in-out p-4 md:p-8 max-w-[1920px] mx-auto ${
          isSidebarCollapsed ? 'md:ml-20' : 'md:ml-64'
        }`}
      >
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/jobs" element={<JobsPage setSidebarCollapsed={setIsSidebarCollapsed} />} />
          <Route path="/jobs/:jobId" element={<JobsPage setSidebarCollapsed={setIsSidebarCollapsed} />} />
          <Route path="/activity" element={<ActivityLog />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<ClientProfilePage />} />
          <Route path="/admin" element={
            role === 'admin' ? <AdminUsersPage /> : <Navigate to="/" replace />
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 z-50 px-6 py-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] safe-area-pb">
        <nav className="flex justify-between items-center">
          {navItems.slice(0, 5).map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.path)}
              className={`flex flex-col items-center gap-1 w-12 transition-colors ${
                currentPage === item.id ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              <item.icon size={24} className={`transition-transform ${currentPage === item.id ? 'scale-110' : ''}`} />
              <span className="text-[10px] font-medium truncate w-full text-center">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <LanguageProvider>
        <MainLayout />
      </LanguageProvider>
    </AuthProvider>
  );
};

export default App;
