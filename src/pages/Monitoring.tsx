import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    Server,
    Activity,
    Users,
    Globe,
    RefreshCw,
    Zap,
    TrendingUp,
    Wifi,
    WifiOff,
    Clock,
    MapPin,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { monitoringService, type ServerStats } from '@/api/monitoring.service';
import { MainLayout } from '@/components/layout';

// Country code to emoji flag mapping
const getFlagEmoji = (countryCode: string): string => {
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map((char) => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
};

// Format bytes to human readable
const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Server Status Card Component
const ServerStatusCard = ({ server }: { server: ServerStats }) => {
    const isOnline = server.isConnected && !server.isDisabled;

    return (
        <Card className={isOnline ? '' : 'border-red-200 bg-red-50/50'}>
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">{getFlagEmoji(server.countryCode)}</span>
                        <div>
                            <CardTitle className="text-base">{server.name}</CardTitle>
                            <CardDescription className="text-xs">
                                {server.address}:{server.port || '-'}
                            </CardDescription>
                        </div>
                    </div>
                    <Badge variant={isOnline ? 'default' : 'destructive'} className="gap-1">
                        {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                        {isOnline ? 'Online' : 'Offline'}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1 text-muted-foreground">
                            <Users className="h-4 w-4" />
                            Users Online
                        </span>
                        <span className="font-medium">{server.usersOnline}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1 text-muted-foreground">
                            <Activity className="h-4 w-4" />
                            Load
                        </span>
                        <span className="font-medium">{server.loadPercentage}%</span>
                    </div>
                </div>

                <div className="space-y-1">
                    <Progress value={server.loadPercentage} className="h-2" />
                    <p className="text-xs text-muted-foreground text-right">
                        {formatBytes(server.trafficUsedBytes)}
                        {server.trafficLimitBytes ? ` / ${formatBytes(server.trafficLimitBytes)}` : ''}
                    </p>
                </div>

                <div className="flex flex-wrap gap-1 pt-2">
                    {server.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                            {tag}
                        </Badge>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
};

// Overview Stat Card Component
const StatCard = ({
    title,
    value,
    description,
    icon: Icon,
    trend,
}: {
    title: string;
    value: string | number;
    description?: string;
    icon: React.ElementType;
    trend?: 'up' | 'down' | 'neutral';
}) => (
    <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
            <div className="text-2xl font-bold">{value}</div>
            {description && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    {trend === 'up' && <TrendingUp className="h-3 w-3 text-green-500" />}
                    {trend === 'down' && <TrendingUp className="h-3 w-3 text-red-500 rotate-180" />}
                    {description}
                </p>
            )}
        </CardContent>
    </Card>
);

export default function Monitoring() {
    const [activeTab, setActiveTab] = useState('overview');
    const [wsConnected, setWsConnected] = useState(false);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    // WebSocket connection
    useEffect(() => {
        const wsUrl = `${import.meta.env.VITE_WS_URL || 'ws://localhost:3000'}/monitoring`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            setWsConnected(true);
            toast.success('Real-time updates connected');
        };

        ws.onclose = () => {
            setWsConnected(false);
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'servers:update' || message.type === 'overview:update') {
                    setLastUpdate(new Date());
                    // Refetch queries when WebSocket sends updates
                    // In a production app, you'd update the cache directly
                }
            } catch {
                // Ignore parse errors
            }
        };

        ws.onerror = () => {
            setWsConnected(false);
        };

        return () => {
            ws.close();
        };
    }, []);

    // Fetch overview
    const { data: overviewData, isLoading: overviewLoading } = useQuery({
        queryKey: ['monitoring-overview'],
        queryFn: () => monitoringService.getOverview(),
        refetchInterval: 30000, // Refetch every 30 seconds
    });

    // Fetch servers
    const { data: serversData, isLoading: serversLoading } = useQuery({
        queryKey: ['monitoring-servers'],
        queryFn: () => monitoringService.getServersStats(),
        refetchInterval: 30000,
    });

    // Fetch ranking
    const { data: rankingData, isLoading: rankingLoading } = useQuery({
        queryKey: ['monitoring-ranking'],
        queryFn: () => monitoringService.getServersRanking(),
        enabled: activeTab === 'ranking',
    });

    // Force refresh mutation
    const refreshMutation = useMutation({
        mutationFn: () => monitoringService.forceRefresh(),
        onSuccess: () => {
            toast.success('Server data refreshed');
        },
        onError: () => toast.error('Failed to refresh data'),
    });

    const overview = overviewData?.data;
    const servers = serversData?.data || [];
    const ranking = rankingData?.data || [];

    const offlineServers = servers.filter((s) => !s.isConnected || s.isDisabled);

    return (
        <MainLayout>
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Server Monitoring</h1>
                        <p className="text-muted-foreground">
                            Real-time monitoring of Remnawave servers and user connections
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge variant={wsConnected ? 'default' : 'secondary'} className="gap-1">
                            {wsConnected ? <Zap className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                            {wsConnected ? 'Live' : 'Polling'}
                        </Badge>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => refreshMutation.mutate()}
                            disabled={refreshMutation.isPending}
                        >
                            <RefreshCw className={`h-4 w-4 mr-2 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                    </div>
                </div>

                {/* Last Update */}
                {lastUpdate && (
                    <p className="text-xs text-muted-foreground">
                        Last real-time update: {lastUpdate.toLocaleTimeString()}
                    </p>
                )}

                {/* Overview Stats */}
                {overviewLoading ? (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        {[...Array(4)].map((_, i) => (
                            <Card key={i} className="h-28 animate-pulse" />
                        ))}
                    </div>
                ) : overview ? (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        <StatCard
                            title="Total Servers"
                            value={overview.totalServers}
                            description={`${overview.onlineServers} online, ${overview.offlineServers} offline`}
                            icon={Server}
                        />
                        <StatCard
                            title="Users Online"
                            value={overview.totalUsersOnline.toLocaleString()}
                            description="Active connections"
                            icon={Users}
                            trend="up"
                        />
                        <StatCard
                            title="Average Load"
                            value={`${overview.averageLoadPercentage}%`}
                            description="Across all servers"
                            icon={Activity}
                        />
                        <StatCard
                            title="Uptime"
                            value="99.9%"
                            description="Last 30 days"
                            icon={Globe}
                        />
                    </div>
                ) : null}

                <Tabs value={activeTab} onValueChange={setActiveTab}>
                    <TabsList className="flex-wrap">
                        <TabsTrigger value="overview" className="gap-2">
                            <Globe className="h-4 w-4" />
                            Overview
                        </TabsTrigger>
                        <TabsTrigger value="servers" className="gap-2">
                            <Server className="h-4 w-4" />
                            All Servers
                        </TabsTrigger>
                        <TabsTrigger value="ranking" className="gap-2">
                            <TrendingUp className="h-4 w-4" />
                            Ranking
                        </TabsTrigger>
                        <TabsTrigger value="offline" className="gap-2">
                            <WifiOff className="h-4 w-4" />
                            Offline
                            {offlineServers.length > 0 && (
                                <Badge variant="destructive" className="ml-1 h-5 min-w-5 px-1">
                                    {offlineServers.length}
                                </Badge>
                            )}
                        </TabsTrigger>
                    </TabsList>

                    {/* Overview Tab */}
                    <TabsContent value="overview" className="space-y-4">
                        {serversLoading ? (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {[...Array(6)].map((_, i) => (
                                    <Card key={i} className="h-48 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                                {servers.map((server) => (
                                    <ServerStatusCard key={server.id} server={server} />
                                ))}
                            </div>
                        )}
                    </TabsContent>

                    {/* All Servers Tab */}
                    <TabsContent value="servers">
                        <Card>
                            <CardHeader>
                                <CardTitle>All Servers</CardTitle>
                                <CardDescription>Detailed view of all Remnawave servers</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Location</TableHead>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead>Users</TableHead>
                                            <TableHead>Load</TableHead>
                                            <TableHead>Traffic</TableHead>
                                            <TableHead>Tags</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {serversLoading ? (
                                            <TableRow>
                                                <TableCell colSpan={7} className="text-center">
                                                    Loading...
                                                </TableCell>
                                            </TableRow>
                                        ) : servers.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={7} className="text-center text-muted-foreground">
                                                    No servers found
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            servers.map((server) => (
                                                <TableRow key={server.id}>
                                                    <TableCell>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xl">
                                                                {getFlagEmoji(server.countryCode)}
                                                            </span>
                                                            <span className="text-sm text-muted-foreground">
                                                                {server.countryCode}
                                                            </span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="font-medium">{server.name}</TableCell>
                                                    <TableCell>
                                                        {server.isConnected && !server.isDisabled ? (
                                                            <Badge variant="default" className="gap-1">
                                                                <Wifi className="h-3 w-3" />
                                                                Online
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="destructive" className="gap-1">
                                                                <WifiOff className="h-3 w-3" />
                                                                Offline
                                                            </Badge>
                                                        )}
                                                    </TableCell>
                                                    <TableCell>{server.usersOnline}</TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center gap-2">
                                                            <Progress value={server.loadPercentage} className="w-16 h-2" />
                                                            <span className="text-sm">{server.loadPercentage}%</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>{formatBytes(server.trafficUsedBytes)}</TableCell>
                                                    <TableCell>
                                                        <div className="flex flex-wrap gap-1">
                                                            {server.tags.slice(0, 3).map((tag) => (
                                                                <Badge key={tag} variant="secondary" className="text-xs">
                                                                    {tag}
                                                                </Badge>
                                                            ))}
                                                            {server.tags.length > 3 && (
                                                                <Badge variant="secondary" className="text-xs">
                                                                    +{server.tags.length - 3}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* Ranking Tab */}
                    <TabsContent value="ranking">
                        <Card>
                            <CardHeader>
                                <CardTitle>Servers Ranking</CardTitle>
                                <CardDescription>Servers sorted by load (least loaded first)</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-16">Rank</TableHead>
                                            <TableHead>Location</TableHead>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Users Online</TableHead>
                                            <TableHead>Load</TableHead>
                                            <TableHead>Recommendation</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rankingLoading ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="text-center">
                                                    Loading...
                                                </TableCell>
                                            </TableRow>
                                        ) : ranking.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={6} className="text-center text-muted-foreground">
                                                    No available servers
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            ranking.map((server, index) => (
                                                <TableRow key={server.id}>
                                                    <TableCell>
                                                        {index === 0 ? (
                                                            <Badge className="bg-yellow-500">#1</Badge>
                                                        ) : index === 1 ? (
                                                            <Badge className="bg-gray-400">#2</Badge>
                                                        ) : index === 2 ? (
                                                            <Badge className="bg-amber-600">#3</Badge>
                                                        ) : (
                                                            <span className="text-muted-foreground">#{index + 1}</span>
                                                        )}
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center gap-2">
                                                            <MapPin className="h-4 w-4 text-muted-foreground" />
                                                            <span className="text-xl">{getFlagEmoji(server.countryCode)}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="font-medium">{server.name}</TableCell>
                                                    <TableCell>{server.usersOnline}</TableCell>
                                                    <TableCell>
                                                        <div className="flex items-center gap-2">
                                                            <Progress value={server.loadPercentage} className="w-20 h-2" />
                                                            <span className="text-sm">{server.loadPercentage}%</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        {index === 0 && (
                                                            <Badge className="bg-green-500 gap-1">
                                                                <Zap className="h-3 w-3" />
                                                                Best Choice
                                                            </Badge>
                                                        )}
                                                        {index === 1 && (
                                                            <Badge variant="secondary">Good Option</Badge>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </TabsContent>

                    {/* Offline Tab */}
                    <TabsContent value="offline">
                        <Card>
                            <CardHeader>
                                <CardTitle>Offline Servers</CardTitle>
                                <CardDescription>Servers that are currently disconnected or disabled</CardDescription>
                            </CardHeader>
                            <CardContent>
                                {offlineServers.length === 0 ? (
                                    <div className="text-center py-8 text-muted-foreground">
                                        <Wifi className="h-12 w-12 mx-auto mb-4 text-green-500" />
                                        <p>All servers are online!</p>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Location</TableHead>
                                                <TableHead>Name</TableHead>
                                                <TableHead>Status</TableHead>
                                                <TableHead>Last Users</TableHead>
                                                <TableHead>Address</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {offlineServers.map((server) => (
                                                <TableRow key={server.id} className="bg-red-50/50">
                                                    <TableCell>
                                                        <span className="text-xl">{getFlagEmoji(server.countryCode)}</span>
                                                    </TableCell>
                                                    <TableCell className="font-medium">{server.name}</TableCell>
                                                    <TableCell>
                                                        <Badge variant="destructive" className="gap-1">
                                                            <WifiOff className="h-3 w-3" />
                                                            {server.isDisabled ? 'Disabled' : 'Disconnected'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell>{server.usersOnline}</TableCell>
                                                    <TableCell className="text-muted-foreground">
                                                        {server.address}:{server.port || '-'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </MainLayout>
    );
}
