import { Link } from 'react-router';
import {
  Users,
  CreditCard,
  DollarSign,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  UserPlus,
  Mail,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';

/**
 * Stat card data interface
 */
interface StatCardData {
  title: string;
  value: string;
  description: string;
  trend: 'up' | 'down' | 'neutral';
  trendValue: string;
  icon: React.ElementType;
  href: string;
}

/**
 * Recent user interface
 */
interface RecentUser {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'expired' | 'pending';
  joinedAt: string;
  avatarUrl?: string;
}

/**
 * Dashboard page component
 * Main admin dashboard with stats, charts, and recent activity
 */
export default function Dashboard(): React.ReactElement {
  // Stats data
  const stats: StatCardData[] = [
    {
      title: 'Total Users',
      value: '2,543',
      description: 'All registered users',
      trend: 'up',
      trendValue: '+12%',
      icon: Users,
      href: '/users',
    },
    {
      title: 'Active Subscriptions',
      value: '1,890',
      description: 'Currently active',
      trend: 'up',
      trendValue: '+8%',
      icon: CreditCard,
      href: '/subscriptions',
    },
    {
      title: 'Monthly Revenue',
      value: '$12,450',
      description: 'Revenue this month',
      trend: 'up',
      trendValue: '+18%',
      icon: DollarSign,
      href: '/statistics',
    },
    {
      title: 'Expiring Soon',
      value: '24',
      description: 'Within 7 days',
      trend: 'down',
      trendValue: '-5%',
      icon: AlertTriangle,
      href: '/subscriptions/expiring',
    },
  ];

  // Recent users data
  const recentUsers: RecentUser[] = [
    {
      id: '1',
      name: 'John Doe',
      email: 'john@example.com',
      status: 'active',
      joinedAt: '2 hours ago',
    },
    {
      id: '2',
      name: 'Jane Smith',
      email: 'jane@example.com',
      status: 'active',
      joinedAt: '5 hours ago',
    },
    {
      id: '3',
      name: 'Mike Johnson',
      email: 'mike@example.com',
      status: 'expired',
      joinedAt: '1 day ago',
    },
    {
      id: '4',
      name: 'Sarah Wilson',
      email: 'sarah@example.com',
      status: 'pending',
      joinedAt: '2 days ago',
    },
    {
      id: '5',
      name: 'Tom Brown',
      email: 'tom@example.com',
      status: 'active',
      joinedAt: '3 days ago',
    },
  ];

  // Quick actions
  const quickActions = [
    { label: 'Add User', icon: UserPlus, href: '/users', variant: 'default' as const },
    { label: 'Send Announcement', icon: Mail, href: '/settings', variant: 'outline' as const },
    { label: 'Renew Subscriptions', icon: RefreshCw, href: '/subscriptions', variant: 'outline' as const },
  ];

  const getStatusBadge = (status: RecentUser['status']): React.ReactElement => {
    const variants: Record<RecentUser['status'], { label: string; className: string }> = {
      active: { label: 'Active', className: 'bg-green-500/10 text-green-500 border-green-500/20' },
      expired: { label: 'Expired', className: 'bg-red-500/10 text-red-500 border-red-500/20' },
      pending: { label: 'Pending', className: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' },
    };
    const { label, className } = variants[status];
    return (
      <Badge variant="outline" className={className}>
        {label}
      </Badge>
    );
  };

  const getUserInitials = (name: string): string => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Welcome back! Here's what's happening with your VPN service.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Button key={action.label} variant={action.variant} size="sm" asChild>
                <Link to={action.href}>
                  <Icon className="mr-2 h-4 w-4" aria-hidden="true" />
                  {action.label}
                </Link>
              </Button>
            );
          })}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          const TrendIcon = stat.trend === 'up' ? TrendingUp : TrendingDown;
          const trendColor = stat.trend === 'up' ? 'text-green-500' : stat.trend === 'down' ? 'text-red-500' : 'text-muted-foreground';

          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
                <div className="flex items-center gap-1 mt-1">
                  <TrendIcon className={`h-3 w-3 ${trendColor}`} aria-hidden="true" />
                  <span className={`text-xs ${trendColor}`}>{stat.trendValue}</span>
                  <span className="text-xs text-muted-foreground">{stat.description}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-7">
        {/* Revenue Chart Placeholder */}
        <Card className="lg:col-span-4">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Revenue Overview</CardTitle>
                <CardDescription>
                  Monthly revenue for the current year
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to="/statistics">
                  View Details
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] flex items-center justify-center border rounded-md bg-muted/10">
              <div className="text-center text-muted-foreground">
                <TrendingUp className="mx-auto h-12 w-12 opacity-50" aria-hidden="true" />
                <h3 className="mt-4 text-lg font-semibold">Revenue Chart Coming Soon</h3>
                <p className="mt-2 text-sm">
                  Interactive charts will be displayed here
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Users */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Recent Users</CardTitle>
                <CardDescription>
                  Latest user registrations
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/users">
                  View All
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentUsers.map((user, index) => (
                <div key={user.id}>
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src={user.avatarUrl} alt={user.name} />
                      <AvatarFallback className="bg-primary/10 text-primary text-sm">
                        {getUserInitials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{user.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {getStatusBadge(user.status)}
                      <span className="text-xs text-muted-foreground">{user.joinedAt}</span>
                    </div>
                  </div>
                  {index < recentUsers.length - 1 && <Separator className="mt-4" />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Stats Row */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Server Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Main Server</span>
                <Badge variant="default" className="bg-green-500">Online</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Backup Server</span>
                <Badge variant="default" className="bg-green-500">Online</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Load Average</span>
                <span className="text-sm font-medium">42%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Today's Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">New Users</span>
                <span className="text-sm font-medium">+12</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">New Subscriptions</span>
                <span className="text-sm font-medium">+8</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Revenue</span>
                <span className="text-sm font-medium">$450.00</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">System Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">API Response</span>
                <span className="text-sm font-medium text-green-500">24ms</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Database</span>
                <Badge variant="default" className="bg-green-500">Healthy</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Last Backup</span>
                <span className="text-sm font-medium">2 hours ago</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
