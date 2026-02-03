import { Link, useLocation } from 'react-router';
import { ChevronRight, Home } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Breadcrumb item interface
 */
interface BreadcrumbItem {
  label: string;
  href: string;
  isLast: boolean;
}

/**
 * Route label mapping
 */
const routeLabels: Record<string, string> = {
  dashboard: 'Dashboard',
  users: 'Users',
  active: 'Active',
  expired: 'Expired',
  subscriptions: 'Subscriptions',
  expiring: 'Expiring Soon',
  plans: 'Plans',
  statistics: 'Statistics',
  settings: 'Settings',
};

/**
 * Generate breadcrumbs from current path
 */
function generateBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const paths = pathname.split('/').filter(Boolean);
  const breadcrumbs: BreadcrumbItem[] = [
    { label: 'Home', href: '/dashboard', isLast: paths.length === 0 },
  ];

  let currentPath = '';
  paths.forEach((path, index) => {
    currentPath += `/${path}`;
    const label = routeLabels[path] || path.charAt(0).toUpperCase() + path.slice(1);
    breadcrumbs.push({
      label,
      href: currentPath,
      isLast: index === paths.length - 1,
    });
  });

  return breadcrumbs;
}

/**
 * Breadcrumbs component for navigation
 */
export function Breadcrumbs({ className }: { className?: string }): React.ReactElement | null {
  const location = useLocation();
  const breadcrumbs = generateBreadcrumbs(location.pathname);

  if (breadcrumbs.length <= 1) {
    return null;
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex items-center text-sm text-muted-foreground', className)}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {breadcrumbs.map((item, index) => {
          const isFirst = index === 0;
          return (
            <li key={item.href} className="flex items-center gap-1.5">
              {!isFirst && (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-muted-foreground/50"
                  aria-hidden="true"
                />
              )}
              {item.isLast ? (
                <span
                  className="font-medium text-foreground"
                  aria-current="page"
                >
                  {isFirst ? (
                    <Home className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    item.label
                  )}
                </span>
              ) : (
                <Link
                  to={item.href}
                  className={cn(
                    'hover:text-foreground transition-colors',
                    isFirst && 'flex items-center'
                  )}
                >
                  {isFirst ? (
                    <Home className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    item.label
                  )}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumbs;