import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

/**
 * MainLayout props interface
 */
interface MainLayoutProps {
  children: React.ReactNode;
}

/**
 * Main layout component for the admin panel
 * Provides sidebar navigation and header
 */
export function MainLayout({ children }: MainLayoutProps): React.ReactElement {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const handleOpenSidebar = (): void => {
    setIsSidebarOpen(true);
  };

  const handleCloseSidebar = (): void => {
    setIsSidebarOpen(false);
  };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <Sidebar isOpen={isSidebarOpen} onClose={handleCloseSidebar} />

      {/* Main content area */}
      <div
        className={cn(
          'flex flex-1 flex-col transition-all duration-300',
          'md:ml-16 lg:ml-64'
        )}
      >
        {/* Header */}
        <Header onMenuClick={handleOpenSidebar} isSidebarOpen={isSidebarOpen} />

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default MainLayout;