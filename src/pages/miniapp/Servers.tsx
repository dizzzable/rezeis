/**
 * MiniApp Servers Page
 * Display available VPN servers with load information
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MiniAppLayout } from '@/components/telegram/MiniAppLayout';
import { PullToRefresh } from '@/components/telegram/PullToRefresh';
import { TelegramBackButton } from '@/components/telegram/TelegramBackButton';
import { useTelegram } from '@/hooks/useTelegram';
import { monitoringService, type ServerStats, type ServerRecommendation } from '@/api/monitoring.service';
import {
    Server,
    Users,
    Activity,
    Wifi,
    WifiOff,
    Zap,
    ChevronRight,
    TrendingUp,
} from 'lucide-react';

// Country code to emoji flag mapping
const getFlagEmoji = (countryCode: string): string => {
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map((char) => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
};


/**
 * Server card component for MiniApp
 */
function ServerCard({
    server,
    rank,
    isRecommended,
}: {
    server: ServerStats;
    rank: number;
    isRecommended: boolean;
}): React.ReactElement {
    const { hapticFeedback } = useTelegram();
    const isOnline = server.isConnected && !server.isDisabled;

    const handleClick = (): void => {
        hapticFeedback('light');
        // Could navigate to server details or copy connection info
    };

    return (
        <Card
            className={`cursor-pointer transition-colors ${
                isRecommended ? 'border-green-500 bg-green-50' : 'hover:bg-accent/50'
            }`}
            onClick={handleClick}
        >
            <CardContent className="p-4">
                <div className="flex items-start gap-3">
                    {/* Rank badge */}
                    <div className="flex flex-col items-center gap-1">
                        {rank === 1 ? (
                            <div className="w-8 h-8 rounded-full bg-yellow-500 flex items-center justify-center">
                                <Zap className="w-4 h-4 text-white" />
                            </div>
                        ) : rank === 2 ? (
                            <div className="w-8 h-8 rounded-full bg-gray-400 flex items-center justify-center text-white text-sm font-bold">
                                2
                            </div>
                        ) : rank === 3 ? (
                            <div className="w-8 h-8 rounded-full bg-amber-600 flex items-center justify-center text-white text-sm font-bold">
                                3
                            </div>
                        ) : (
                            <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-sm font-bold">
                                {rank}
                            </div>
                        )}
                    </div>

                    {/* Server info */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-2xl">{getFlagEmoji(server.countryCode)}</span>
                            <h3 className="font-medium truncate">{server.name}</h3>
                            {isRecommended && (
                                <Badge className="bg-green-500 text-white text-xs">
                                    Рекомендуем
                                </Badge>
                            )}
                        </div>

                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                                {isOnline ? (
                                    <Wifi className="w-3 h-3 text-green-500" />
                                ) : (
                                    <WifiOff className="w-3 h-3 text-red-500" />
                                )}
                                {isOnline ? 'Online' : 'Offline'}
                            </span>
                            <span className="flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {server.usersOnline} users
                            </span>
                            <span className="flex items-center gap-1">
                                <Activity className="w-3 h-3" />
                                {server.loadPercentage}%
                            </span>
                        </div>

                        {/* Load bar */}
                        <div className="mt-2">
                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${
                                        server.loadPercentage < 50
                                            ? 'bg-green-500'
                                            : server.loadPercentage < 80
                                            ? 'bg-yellow-500'
                                            : 'bg-red-500'
                                    }`}
                                    style={{ width: `${server.loadPercentage}%` }}
                                />
                            </div>
                        </div>

                        {server.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                {server.tags.slice(0, 2).map((tag) => (
                                    <Badge key={tag} variant="secondary" className="text-[10px] px-1 py-0">
                                        {tag}
                                    </Badge>
                                ))}
                                {server.tags.length > 2 && (
                                    <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                        +{server.tags.length - 2}
                                    </Badge>
                                )}
                            </div>
                        )}
                    </div>

                    <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                </div>
            </CardContent>
        </Card>
    );
}

/**
 * Recommended server card
 */
function RecommendedServerCard({
    recommendation,
    onConnect,
}: {
    recommendation: ServerRecommendation | null;
    onConnect: () => void;
}): React.ReactElement {
    const { hapticFeedback } = useTelegram();

    const handleConnect = (): void => {
        hapticFeedback('medium');
        onConnect();
    };

    if (!recommendation) {
        return (
            <Card className="border-yellow-500/50 bg-yellow-500/5">
                <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center">
                            <Server className="w-5 h-5 text-yellow-600" />
                        </div>
                        <div>
                            <h3 className="font-medium">Нет доступных серверов</h3>
                            <p className="text-xs text-muted-foreground">
                                Все серверы временно недоступны
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="border-green-500 bg-green-50">
            <CardHeader className="p-4 pb-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center">
                            <Zap className="w-4 h-4 text-white" />
                        </div>
                        <div>
                            <CardTitle className="text-sm">Лучший выбор</CardTitle>
                            <p className="text-xs text-muted-foreground">{recommendation.reason}</p>
                        </div>
                    </div>
                    <Badge className="bg-green-500 text-white">{recommendation.score}/100</Badge>
                </div>
            </CardHeader>
            <CardContent className="p-4 pt-2">
                <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl">{getFlagEmoji(recommendation.countryCode)}</span>
                    <div>
                        <h3 className="font-semibold text-lg">{recommendation.serverName}</h3>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {recommendation.usersOnline} users
                            </span>
                            <span className="flex items-center gap-1">
                                <Activity className="w-3 h-3" />
                                {recommendation.loadPercentage}% load
                            </span>
                        </div>
                    </div>
                </div>

                <div className="h-2 w-full bg-muted rounded-full overflow-hidden mb-3">
                    <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${recommendation.loadPercentage}%` }}
                    />
                </div>

                <Button onClick={handleConnect} className="w-full bg-green-600 hover:bg-green-700">
                    <Zap className="w-4 h-4 mr-2" />
                    Подключиться
                </Button>
            </CardContent>
        </Card>
    );
}

/**
 * Stats overview card
 */
function StatsOverview({
    totalServers,
    onlineServers,
    totalUsers,
}: {
    totalServers: number;
    onlineServers: number;
    totalUsers: number;
}): React.ReactElement {
    return (
        <div className="grid grid-cols-3 gap-2">
            <Card>
                <CardContent className="p-3 text-center">
                    <p className="text-xl font-bold text-primary">{totalServers}</p>
                    <p className="text-[10px] text-muted-foreground uppercase">Серверов</p>
                </CardContent>
            </Card>
            <Card>
                <CardContent className="p-3 text-center">
                    <p className="text-xl font-bold text-green-600">{onlineServers}</p>
                    <p className="text-[10px] text-muted-foreground uppercase">Онлайн</p>
                </CardContent>
            </Card>
            <Card>
                <CardContent className="p-3 text-center">
                    <p className="text-xl font-bold text-blue-600">{totalUsers}</p>
                    <p className="text-[10px] text-muted-foreground uppercase">Пользователей</p>
                </CardContent>
            </Card>
        </div>
    );
}

/**
 * MiniApp Servers page
 */
export function MiniAppServers(): React.ReactElement {
    const navigate = useNavigate();
    const { hapticFeedback, isInTelegram } = useTelegram();
    const [wsConnected, setWsConnected] = useState(false);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    // WebSocket connection for real-time updates
    useEffect(() => {
        if (!isInTelegram) return;

        const wsUrl = `${import.meta.env.VITE_WS_URL || 'ws://localhost:3000'}/monitoring`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            setWsConnected(true);
        };

        ws.onclose = () => {
            setWsConnected(false);
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'servers:update') {
                    setLastUpdate(new Date());
                    // Could update cache directly here
                }
            } catch {
                // Ignore parse errors
            }
        };

        return () => {
            ws.close();
        };
    }, [isInTelegram]);

    // Fetch servers ranking
    const { data: rankingData, refetch: refetchRanking, isLoading: rankingLoading } = useQuery({
        queryKey: ['miniapp-servers-ranking'],
        queryFn: () => monitoringService.getServersRanking(),
    });

    // Fetch recommended server
    const { data: recommendedData, refetch: refetchRecommended } = useQuery({
        queryKey: ['miniapp-recommended-server'],
        queryFn: () => monitoringService.getRecommendedServer(),
    });

    // Fetch overview
    const { data: overviewData, refetch: refetchOverview } = useQuery({
        queryKey: ['miniapp-monitoring-overview'],
        queryFn: () => monitoringService.getOverview(),
    });

    const servers = rankingData?.data || [];
    const recommendation = recommendedData?.data || null;
    const overview = overviewData?.data;

    // Handle refresh
    const handleRefresh = useCallback(async (): Promise<void> => {
        await Promise.all([refetchRanking(), refetchRecommended(), refetchOverview()]);
    }, [refetchRanking, refetchRecommended, refetchOverview]);

    // Handle back navigation
    const handleBack = useCallback((): void => {
        hapticFeedback('light');
        navigate('/miniapp');
    }, [hapticFeedback, navigate]);

    // Handle connect to recommended server
    const handleConnect = useCallback((): void => {
        hapticFeedback('success');
        // Could copy config or open connection dialog
        // For now, just show a toast-like notification
    }, [hapticFeedback]);

    return (
        <MiniAppLayout title="Серверы" contentClassName="pb-4">
            <TelegramBackButton onClick={handleBack} isVisible={true} />

            <PullToRefresh onRefresh={handleRefresh} className="h-full">
                <div className="p-4 space-y-4">
                    {/* Connection status */}
                    {wsConnected && (
                        <div className="flex items-center justify-center gap-1 text-xs text-green-600">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            Live обновления
                        </div>
                    )}

                    {/* Last update */}
                    {lastUpdate && (
                        <p className="text-[10px] text-center text-muted-foreground">
                            Обновлено: {lastUpdate.toLocaleTimeString()}
                        </p>
                    )}

                    {/* Stats overview */}
                    {overview && (
                        <StatsOverview
                            totalServers={overview.totalServers}
                            onlineServers={overview.onlineServers}
                            totalUsers={overview.totalUsersOnline}
                        />
                    )}

                    {/* Recommended server */}
                    <div className="space-y-2">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                            <Zap className="w-4 h-4" />
                            Рекомендуем
                        </h2>
                        <RecommendedServerCard
                            recommendation={recommendation}
                            onConnect={handleConnect}
                        />
                    </div>

                    {/* All servers ranking */}
                    <div className="space-y-2">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                            <TrendingUp className="w-4 h-4" />
                            Рейтинг серверов
                        </h2>

                        {rankingLoading ? (
                            <div className="space-y-2">
                                {[...Array(3)].map((_, i) => (
                                    <Card key={i} className="h-24 animate-pulse" />
                                ))}
                            </div>
                        ) : servers.length === 0 ? (
                            <Card>
                                <CardContent className="p-6 text-center">
                                    <Server className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                                    <p className="text-sm text-muted-foreground">Нет доступных серверов</p>
                                </CardContent>
                            </Card>
                        ) : (
                            <div className="space-y-2">
                                {servers.map((server, index) => (
                                    <ServerCard
                                        key={server.id}
                                        server={server}
                                        rank={index + 1}
                                        isRecommended={recommendation?.serverId === server.id}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Info note */}
                    <div className="text-center p-4">
                        <p className="text-xs text-muted-foreground">
                            Серверы сортируются по загрузке автоматически
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                            Рекомендуем выбирать серверы с меньшим количеством пользователей
                        </p>
                    </div>
                </div>
            </PullToRefresh>
        </MiniAppLayout>
    );
}

export default MiniAppServers;
