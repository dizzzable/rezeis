import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ClientSidebar } from './ClientSidebar';
import { ClientHeader } from './ClientHeader';

/**
 * ClientLayout props interface
 */
interface ClientLayoutProps {
  children: React.ReactNode;
}

/**
 * Client layout component for the user dashboard
 * Provides sidebar navigation and header
 */
export function ClientLayout({ children }: ClientLayoutProps): React.ReactElement {
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
      <ClientSidebar isOpen={isSidebarOpen} onClose={handleCloseSidebar} />

      {/* Main content area */}
      <div
        className={cn(
          'flex flex-1 flex-col transition-all duration-300',
          'md:ml-16 lg:ml-64'
        )}
      >
        {/* Header */}
        <ClientHeader onMenuClick={handleOpenSidebar} />

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default ClientLayout;
