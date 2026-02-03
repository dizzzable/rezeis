import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Users,
  CreditCard,
  DollarSign,
  Activity,
  Calendar,
  Download,
  Filter,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { statisticsService } from '@/api/statistics.service';
import * as XLSX from 'xlsx';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
} from 'recharts';

// Pagination constants
const ITEMS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

/**
 * Statistics page component with advanced analytics
 * Features: date range picker, charts, KPI cards, data table, export
 */
export default function Statistics(): React.ReactElement {
  // Date range state (default to last 30 days)
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [minRevenue, setMinRevenue] = useState('');
  const [minUsers, setMinUsers] = useState('');

  // Fetch statistics data
  const {
    data: dailyStats = [],
    isLoading: isLoadingDaily,
    isError: isErrorDaily,
    error: errorDaily,
  } = useQuery({
    queryKey: ['dailyStatistics', startDate, endDate],
    queryFn: () =>
      statisticsService.getDailyStatistics(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      ),
  });

  const { data: revenueStats, isLoading: isLoadingRevenue } = useQuery({
    queryKey: ['revenueStats', startDate, endDate],
    queryFn: () =>
      statisticsService.getRevenueStats(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      ),
  });

  const { data: userStats, isLoading: isLoadingUsers } = useQuery({
    queryKey: ['userStats'],
    queryFn: () => statisticsService.getUserStats(),
  });

  const { data: subscriptionStats, isLoading: isLoadingSubscriptions } = useQuery({
    queryKey: ['subscriptionStats'],
    queryFn: () => statisticsService.getSubscriptionStats(),
  });

  // Filter data based on filters
  const filteredStats = useMemo(() => {
    let result = [...dailyStats];

    if (minRevenue) {
      result = result.filter((stat) => stat.revenue >= Number(minRevenue));
    }
    if (minUsers) {
      result = result.filter((stat) => stat.newUsers >= Number(minUsers));
    }

    return result;
  }, [dailyStats, minRevenue, minUsers]);

  // Sort by date (descending)
  const sortedStats = useMemo(() => {
    return [...filteredStats].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [filteredStats]);

  // Pagination
  const totalStats = sortedStats.length;
  const totalPages = Math.ceil(totalStats / itemsPerPage);
  const paginatedStats = sortedStats.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  // Chart data (sorted by date ascending for charts)
  const chartData = useMemo(() => {
    return [...filteredStats]
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((stat) => ({
        date: new Date(stat.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        fullDate: stat.date,
        revenue: stat.revenue,
        newUsers: stat.newUsers,
        activeUsers: stat.activeUsers,
        newSubscriptions: stat.newSubscriptions,
      }));
  }, [filteredStats]);

  // Clear filters
  const clearFilters = () => {
    setMinRevenue('');
    setMinUsers('');
    setCurrentPage(1);
  };

  const hasActiveFilters = minRevenue || minUsers;

  // Export to Excel
  const handleExportToExcel = () => {
    const exportData = sortedStats.map((stat) => ({
      Date: new Date(stat.date).toLocaleDateString(),
      'New Users': stat.newUsers,
      'Active Users': stat.activeUsers,
      'New Subscriptions': stat.newSubscriptions,
      Revenue: stat.revenue,
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Statistics');

    const colWidths = [{ wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 12 }];
    ws['!cols'] = colWidths;

    const timestamp = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `statistics-export-${timestamp}.xlsx`);
  };

  // Pagination handlers
  const goToFirstPage = () => setCurrentPage(1);
  const goToPreviousPage = () => setCurrentPage((p) => Math.max(1, p - 1));
  const goToNextPage = () => setCurrentPage((p) => Math.min(totalPages, p + 1));
  const goToLastPage = () => setCurrentPage(totalPages);

  // Calculate totals for the period
  const periodTotals = useMemo(() => {
    return filteredStats.reduce(
      (acc, stat) => ({
        revenue: acc.revenue + stat.revenue,
        newUsers: acc.newUsers + stat.newUsers,
        activeUsers: Math.max(acc.activeUsers, stat.activeUsers),
        newSubscriptions: acc.newSubscriptions + stat.newSubscriptions,
      }),
      { revenue: 0, newUsers: 0, activeUsers: 0, newSubscriptions: 0 }
    );
  }, [filteredStats]);

  // Format currency
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Statistics</h1>
          <p className="text-muted-foreground mt-1">View analytics and performance metrics</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExportToExcel}>
            <Download className="mr-2 h-4 w-4" />
            Export Excel
          </Button>
        </div>
      </div>

      {/* Date Range Picker */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="space-y-2 flex-1">
              <Label className="text-xs font-medium flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Start Date
              </Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-2 flex-1">
              <Label className="text-xs font-medium flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                End Date
              </Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setShowFilters(!showFilters)}
                className={showFilters ? 'bg-accent' : ''}
              >
                <Filter className="mr-2 h-4 w-4" />
                Filters
                {hasActiveFilters && (
                  <Badge variant="secondary" className="ml-2">
                    Active
                  </Badge>
                )}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  <X className="mr-1 h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </div>

          {/* Advanced Filters */}
          {showFilters && (
            <div className="grid gap-4 sm:grid-cols-2 mt-4 pt-4 border-t">
              <div className="space-y-2">
                <Label className="text-xs font-medium">Min Revenue ($)</Label>
                <Input
                  type="number"
                  placeholder="Filter by min revenue..."
                  value={minRevenue}
                  onChange={(e) => {
                    setMinRevenue(e.target.value);
                    setCurrentPage(1);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-medium">Min New Users</Label>
                <Input
                  type="number"
                  placeholder="Filter by min users..."
                  value={minUsers}
                  onChange={(e) => {
                    setMinUsers(e.target.value);
                    setCurrentPage(1);
                  }}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Period Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingRevenue ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <>
                <div className="text-2xl font-bold">{formatCurrency(periodTotals.revenue)}</div>
                <div className="flex items-center gap-1 mt-1">
                  {revenueStats && revenueStats.growthRate >= 0 ? (
                    <>
                      <TrendingUp className="h-3 w-3 text-green-500" />
                      <Badge variant="outline" className="text-green-500 border-green-500">
                        +{revenueStats.growthRate.toFixed(1)}%
                      </Badge>
                    </>
                  ) : (
                    <>
                      <TrendingDown className="h-3 w-3 text-red-500" />
                      <Badge variant="outline" className="text-red-500 border-red-500">
                        {revenueStats?.growthRate.toFixed(1)}%
                      </Badge>
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">vs prev period</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingUsers ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <>
                <div className="text-2xl font-bold">+{periodTotals.newUsers.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-1">
                  {userStats && userStats.growthRate >= 0 ? (
                    <>
                      <TrendingUp className="h-3 w-3 text-green-500" />
                      <Badge variant="outline" className="text-green-500 border-green-500">
                        +{userStats.growthRate.toFixed(1)}%
                      </Badge>
                    </>
                  ) : (
                    <>
                      <TrendingDown className="h-3 w-3 text-red-500" />
                      <Badge variant="outline" className="text-red-500 border-red-500">
                        {userStats?.growthRate.toFixed(1)}%
                      </Badge>
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">vs prev period</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Subscriptions</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSubscriptions ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <>
                <div className="text-2xl font-bold">+{periodTotals.newSubscriptions.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-1">
                  <Badge variant="outline" className="text-blue-500 border-blue-500">
                    {subscriptionStats?.activeSubscriptions.toLocaleString() || 0} active
                  </Badge>
                  <span className="text-xs text-muted-foreground">total active</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Peak Active Users</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingDaily ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <>
                <div className="text-2xl font-bold">{periodTotals.activeUsers.toLocaleString()}</div>
                <div className="flex items-center gap-1 mt-1">
                  <Badge variant="outline" className="text-purple-500 border-purple-500">
                    {filteredStats.length} days
                  </Badge>
                  <span className="text-xs text-muted-foreground">in period</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Section */}
      <Tabs defaultValue="revenue" className="space-y-4">
        <TabsList>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="combined">Combined</TabsTrigger>
        </TabsList>

        <TabsContent value="revenue" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Revenue Overview</CardTitle>
              <CardDescription>Daily revenue for the selected period</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickMargin={10}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => `$${value}`}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                        }}
                        formatter={(value) => [formatCurrency(value as number), 'Revenue']}
                      />
                      <Area
                        type="monotone"
                        dataKey="revenue"
                        stroke="#10b981"
                        fillOpacity={1}
                        fill="url(#colorRevenue)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    No data available for the selected period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>User Growth</CardTitle>
              <CardDescription>New user registrations over time</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickMargin={10}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                        }}
                      />
                      <Bar dataKey="newUsers" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    No data available for the selected period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="subscriptions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Subscription Activity</CardTitle>
              <CardDescription>New subscriptions per day</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickMargin={10}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="newSubscriptions"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        dot={{ fill: '#8b5cf6', r: 4 }}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    No data available for the selected period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="combined" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Combined Metrics</CardTitle>
              <CardDescription>Revenue, users, and subscriptions overview</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12 }}
                        tickMargin={10}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis yAxisId="left" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => `$${value}`}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                        }}
                      />
                      <Legend />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="newUsers"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="New Users"
                      />
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="newSubscriptions"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        dot={false}
                        name="New Subscriptions"
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="revenue"
                        stroke="#10b981"
                        strokeWidth={2}
                        dot={false}
                        name="Revenue ($)"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    No data available for the selected period
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Data Table */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Statistics</CardTitle>
          <CardDescription>Detailed breakdown by day</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingDaily ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : isErrorDaily ? (
            <div className="text-center py-12 text-muted-foreground">
              <BarChart3 className="mx-auto h-12 w-12 mb-4" />
              <p>Failed to load statistics</p>
              <p className="text-sm">{(errorDaily as Error)?.message}</p>
            </div>
          ) : paginatedStats.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BarChart3 className="mx-auto h-12 w-12 opacity-50 mb-4" />
              <p>No statistics found for the selected period</p>
              {hasActiveFilters && (
                <Button variant="link" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-medium text-sm">Date</th>
                      <th className="text-left py-3 px-4 font-medium text-sm">New Users</th>
                      <th className="text-left py-3 px-4 font-medium text-sm">Active Users</th>
                      <th className="text-left py-3 px-4 font-medium text-sm">New Subscriptions</th>
                      <th className="text-left py-3 px-4 font-medium text-sm">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedStats.map((stat) => (
                      <tr key={stat.id} className="border-b last:border-0 hover:bg-muted/50">
                        <td className="py-3 px-4 text-sm">
                          {new Date(stat.date).toLocaleDateString('en-US', {
                            weekday: 'short',
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </td>
                        <td className="py-3 px-4 text-sm">
                          <Badge variant="outline" className="font-mono">
                            +{stat.newUsers}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-sm">{stat.activeUsers.toLocaleString()}</td>
                        <td className="py-3 px-4 text-sm">
                          <Badge variant="outline" className="font-mono bg-purple-500/10 text-purple-500">
                            +{stat.newSubscriptions}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-sm font-medium">{formatCurrency(stat.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-6">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Show</span>
                    <select
                      value={itemsPerPage}
                      onChange={(e) => {
                        setItemsPerPage(Number(e.target.value));
                        setCurrentPage(1);
                      }}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      {ITEMS_PER_PAGE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                    <span className="text-sm text-muted-foreground">entries</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    Showing {((currentPage - 1) * itemsPerPage) + 1} to{' '}
                    {Math.min(currentPage * itemsPerPage, totalStats)} of {totalStats} entries
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goToFirstPage}
                    disabled={currentPage === 1}
                    className="h-8 w-8"
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goToPreviousPage}
                    disabled={currentPage === 1}
                    className="h-8 w-8"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm px-3">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goToNextPage}
                    disabled={currentPage === totalPages}
                    className="h-8 w-8"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={goToLastPage}
                    disabled={currentPage === totalPages}
                    className="h-8 w-8"
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Dashboard Summary Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Revenue Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoadingRevenue ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Revenue</span>
                  <span className="font-medium">{formatCurrency(revenueStats?.totalRevenue || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Period Revenue</span>
                  <span className="font-medium">{formatCurrency(revenueStats?.periodRevenue || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Avg Daily</span>
                  <span className="font-medium">{formatCurrency(revenueStats?.averageDailyRevenue || 0)}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">User Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoadingUsers ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Users</span>
                  <span className="font-medium">{userStats?.totalUsers.toLocaleString() || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Active Users</span>
                  <span className="font-medium">{userStats?.activeUsers.toLocaleString() || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">New This Month</span>
                  <span className="font-medium">{userStats?.newUsersThisMonth.toLocaleString() || 0}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Subscription Stats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoadingSubscriptions ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium">{subscriptionStats?.totalSubscriptions.toLocaleString() || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Active</span>
                  <span className="font-medium text-green-500">
                    {subscriptionStats?.activeSubscriptions.toLocaleString() || 0}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Expiring Soon</span>
                  <span className="font-medium text-yellow-500">
                    {subscriptionStats?.expiringSoon.toLocaleString() || 0}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
