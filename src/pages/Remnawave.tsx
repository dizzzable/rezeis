import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Server,
  Key,
  RefreshCw,
  Settings,
  Activity,
  CheckCircle,
  AlertTriangle,
  Trash2,
  Edit,
  Users,
  Link2,
  Search,
  Star,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { remnawaveService, type RemnawaveServer, type UserVpnKey } from '@/api/remnawave.service';
import { MainLayout } from '@/components/layout';

export default function Remnawave() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('settings');
  const [configForm, setConfigForm] = useState({
    apiUrl: '',
    apiToken: '',
    isActive: false,
    syncIntervalMinutes: 60,
  });
  const [testLoading, setTestLoading] = useState(false);
  const [_selectedServer] = useState<RemnawaveServer | null>(null);
  const [_selectedKey] = useState<UserVpnKey | null>(null);
  const [, setIsEditServerOpen] = useState(false);

  // User Links state
  const [telegramSearchQuery, setTelegramSearchQuery] = useState('');
  const [isLinkDialogOpen, setIsLinkDialogOpen] = useState(false);
  const [selectedRemnawaveUuid, setSelectedRemnawaveUuid] = useState('');
  const [linkTelegramId, setLinkTelegramId] = useState('');

  // Fetch config
  const { data: config } = useQuery({
    queryKey: ['remnawave-config'],
    queryFn: () => remnawaveService.getConfig(),
  });

  // Fetch servers
  const { data: serversData, isLoading: serversLoading } = useQuery({
    queryKey: ['remnawave-servers'],
    queryFn: () => remnawaveService.getServers({ limit: 100 }),
    enabled: activeTab === 'servers',
  });

  // Fetch keys
  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ['remnawave-keys'],
    queryFn: () => remnawaveService.getKeys({ limit: 100 }),
    enabled: activeTab === 'keys',
  });

  // Fetch traffic stats
  const { data: trafficStats } = useQuery({
    queryKey: ['remnawave-traffic'],
    queryFn: () => remnawaveService.getTrafficStats(),
    enabled: activeTab === 'traffic',
  });

  // Fetch sync logs
  const { data: syncLogsData } = useQuery({
    queryKey: ['remnawave-logs'],
    queryFn: () => remnawaveService.getSyncLogs({ limit: 50 }),
    enabled: activeTab === 'logs',
  });

  // Fetch user links
  const { data: userLinksData, isLoading: userLinksLoading } = useQuery({
    queryKey: ['remnawave-user-links'],
    queryFn: () => remnawaveService.getUserLinks({ page: 1, limit: 50 }),
    enabled: activeTab === 'user-links',
  });

  // Update config mutation
  const updateConfigMutation = useMutation({
    mutationFn: (data: Partial<typeof configForm>) => remnawaveService.updateConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-config'] });
      toast.success('Configuration updated successfully');
    },
    onError: () => toast.error('Failed to update configuration'),
  });

  // Sync servers mutation
  const syncServersMutation = useMutation({
    mutationFn: () => remnawaveService.syncServers(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-servers'] });
      toast.success(`Synced ${data.synced} servers`);
    },
    onError: () => toast.error('Failed to sync servers'),
  });

  // Test connection
  const handleTestConnection = async () => {
    setTestLoading(true);
    try {
      const result = await remnawaveService.testConnection(configForm.apiUrl, configForm.apiToken);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setTestLoading(false);
    }
  };

  // Update config
  const handleUpdateConfig = () => {
    updateConfigMutation.mutate(configForm);
  };

  // Sync key
  const syncKeyMutation = useMutation({
    mutationFn: (id: string) => remnawaveService.syncKey(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-keys'] });
      toast.success('Key synced successfully');
    },
    onError: () => toast.error('Failed to sync key'),
  });

  // Delete key
  const deleteKeyMutation = useMutation({
    mutationFn: (id: string) => remnawaveService.deleteKey(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-keys'] });
      toast.success('Key deleted successfully');
    },
    onError: () => toast.error('Failed to delete key'),
  });

  // Sync all users mutation
  const syncAllUsersMutation = useMutation({
    mutationFn: () => remnawaveService.syncAllUsers(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-user-links'] });
      toast.success(`Sync completed: ${data.data.report.linked} linked, ${data.data.report.created} created`);
    },
    onError: () => toast.error('Failed to sync users'),
  });

  // Link Telegram mutation
  const linkTelegramMutation = useMutation({
    mutationFn: ({ uuid, telegramId }: { uuid: string; telegramId: string }) =>
      remnawaveService.linkTelegramToUser(uuid, telegramId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-user-links'] });
      toast.success('Telegram linked successfully');
      setIsLinkDialogOpen(false);
      setSelectedRemnawaveUuid('');
      setLinkTelegramId('');
    },
    onError: () => toast.error('Failed to link Telegram'),
  });

  // Set primary link mutation
  const setPrimaryLinkMutation = useMutation({
    mutationFn: ({ linkId, userId }: { linkId: string; userId: string }) =>
      remnawaveService.setPrimaryLink(linkId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-user-links'] });
      toast.success('Primary link updated');
    },
    onError: () => toast.error('Failed to set primary link'),
  });

  // Delete link mutation
  const deleteLinkMutation = useMutation({
    mutationFn: (linkId: string) => remnawaveService.deleteLink(linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remnawave-user-links'] });
      toast.success('Link deleted successfully');
    },
    onError: () => toast.error('Failed to delete link'),
  });

  // Search users by Telegram ID
  const searchUsersMutation = useMutation({
    mutationFn: (telegramId: string) => remnawaveService.getUsersByTelegramId(telegramId),
    onSuccess: (data) => {
      if (data.data.totalCount === 0) {
        toast.info('No users found for this Telegram ID');
      } else {
        toast.success(`Found ${data.data.totalCount} user(s)`);
      }
    },
    onError: () => toast.error('Failed to search users'),
  });

  useEffect(() => {
    if (config) {
      setConfigForm({
        apiUrl: config.apiUrl,
        apiToken: '',
        isActive: config.isActive,
        syncIntervalMinutes: config.syncIntervalMinutes,
      });
    }
  }, [config]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSearchByTelegram = () => {
    if (!telegramSearchQuery || !/^\d+$/.test(telegramSearchQuery)) {
      toast.error('Please enter a valid Telegram ID (numbers only)');
      return;
    }
    searchUsersMutation.mutate(telegramSearchQuery);
  };

  const handleOpenLinkDialog = (uuid: string) => {
    setSelectedRemnawaveUuid(uuid);
    setIsLinkDialogOpen(true);
  };

  const handleLinkTelegram = () => {
    if (!linkTelegramId || !/^\d+$/.test(linkTelegramId)) {
      toast.error('Please enter a valid Telegram ID');
      return;
    }
    linkTelegramMutation.mutate({ uuid: selectedRemnawaveUuid, telegramId: linkTelegramId });
  };

  return (
    <MainLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Remnawave Integration</h1>
            <p className="text-muted-foreground">
              Manage VPN panel integration and user key synchronization
            </p>
          </div>
          {config?.isActive && (
            <Badge variant="default" className="gap-1">
              <CheckCircle className="h-3 w-3" />
              Connected
            </Badge>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="settings" className="gap-2">
              <Settings className="h-4 w-4" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="servers" className="gap-2">
              <Server className="h-4 w-4" />
              Servers
            </TabsTrigger>
            <TabsTrigger value="keys" className="gap-2">
              <Key className="h-4 w-4" />
              VPN Keys
            </TabsTrigger>
            <TabsTrigger value="traffic" className="gap-2">
              <Activity className="h-4 w-4" />
              Traffic
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Sync Logs
            </TabsTrigger>
            <TabsTrigger value="user-links" className="gap-2">
              <Users className="h-4 w-4" />
              User Links
            </TabsTrigger>
          </TabsList>

          {/* Settings Tab */}
          <TabsContent value="settings" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Connection Settings</CardTitle>
                <CardDescription>
                  Configure your Remnawave panel API connection
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="apiUrl">API URL</Label>
                    <Input
                      id="apiUrl"
                      placeholder="https://remnawave.example.com"
                      value={configForm.apiUrl}
                      onChange={(e) => setConfigForm({ ...configForm, apiUrl: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apiToken">API Token</Label>
                    <Input
                      id="apiToken"
                      type="password"
                      placeholder="Enter your API token"
                      value={configForm.apiToken}
                      onChange={(e) => setConfigForm({ ...configForm, apiToken: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave empty to keep the current token
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="syncInterval">Sync Interval (minutes)</Label>
                    <Input
                      id="syncInterval"
                      type="number"
                      min={1}
                      max={1440}
                      value={configForm.syncIntervalMinutes}
                      onChange={(e) => setConfigForm({ ...configForm, syncIntervalMinutes: parseInt(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Active</Label>
                      <p className="text-xs text-muted-foreground">
                        Enable Remnawave integration
                      </p>
                    </div>
                    <Switch
                      checked={configForm.isActive}
                      onCheckedChange={(checked) => setConfigForm({ ...configForm, isActive: checked })}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleTestConnection} disabled={testLoading} variant="outline">
                    {testLoading ? 'Testing...' : 'Test Connection'}
                  </Button>
                  <Button onClick={handleUpdateConfig} disabled={updateConfigMutation.isPending}>
                    {updateConfigMutation.isPending ? 'Saving...' : 'Save Configuration'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {config?.lastSyncAt && (
              <Card>
                <CardHeader>
                  <CardTitle>Last Sync</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    Last successful sync: {new Date(config.lastSyncAt).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Servers Tab */}
          <TabsContent value="servers">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Servers</CardTitle>
                  <CardDescription>Manage Remnawave servers and nodes</CardDescription>
                </div>
                <Button
                  onClick={() => syncServersMutation.mutate()}
                  disabled={syncServersMutation.isPending}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${syncServersMutation.isPending ? 'animate-spin' : ''}`} />
                  Sync Servers
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Address</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Traffic</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {serversLoading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center">Loading...</TableCell>
                      </TableRow>
                    ) : serversData?.data.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No servers found. Click "Sync Servers" to fetch from Remnawave.
                        </TableCell>
                      </TableRow>
                    ) : (
                      serversData?.data.map((server) => (
                        <TableRow key={server.id}>
                          <TableCell className="font-medium">{server.name}</TableCell>
                          <TableCell>{server.address}:{server.port}</TableCell>
                          <TableCell className="uppercase">{server.protocol}</TableCell>
                          <TableCell>
                            <Badge variant={server.isActive ? 'default' : 'secondary'}>
                              {server.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatBytes(server.trafficUsed)}</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setIsEditServerOpen(true);
                              }}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Keys Tab */}
          <TabsContent value="keys">
            <Card>
              <CardHeader>
                <CardTitle>VPN Keys</CardTitle>
                <CardDescription>Manage user VPN keys</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User ID</TableHead>
                      <TableHead>Server</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Traffic Used</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="w-[150px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keysLoading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center">Loading...</TableCell>
                      </TableRow>
                    ) : keysData?.data.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          No VPN keys found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      keysData?.data.map((key) => (
                        <TableRow key={key.id}>
                          <TableCell className="font-medium">{key.userId}</TableCell>
                          <TableCell>{key.serverId}</TableCell>
                          <TableCell>
                            <Badge variant={key.isActive ? 'default' : 'secondary'}>
                              {key.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatBytes(key.trafficUsed)}</TableCell>
                          <TableCell>
                            {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'Never'}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => syncKeyMutation.mutate(key.id)}
                                disabled={syncKeyMutation.isPending}
                              >
                                <RefreshCw className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteKeyMutation.mutate(key.id)}
                                disabled={deleteKeyMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
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

          {/* Traffic Tab */}
          <TabsContent value="traffic">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Traffic Used</CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatBytes(trafficStats?.totalTrafficUsed || 0)}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Active Keys</CardTitle>
                  <Key className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{trafficStats?.activeKeysCount || 0}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Inactive Keys</CardTitle>
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{trafficStats?.inactiveKeysCount || 0}</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Servers</CardTitle>
                  <Server className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{trafficStats?.serverStats.length || 0}</div>
                </CardContent>
              </Card>
            </div>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Server Traffic Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Server</TableHead>
                      <TableHead>Keys Count</TableHead>
                      <TableHead>Traffic Used</TableHead>
                      <TableHead>Traffic Limit</TableHead>
                      <TableHead>Usage %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trafficStats?.serverStats.map((stat) => (
                      <TableRow key={stat.serverId}>
                        <TableCell className="font-medium">{stat.serverName}</TableCell>
                        <TableCell>{stat.keysCount}</TableCell>
                        <TableCell>{formatBytes(stat.trafficUsed)}</TableCell>
                        <TableCell>{formatBytes(stat.trafficLimit)}</TableCell>
                        <TableCell>
                          {stat.trafficLimit > 0
                            ? `${((stat.trafficUsed / stat.trafficLimit) * 100).toFixed(1)}%`
                            : 'N/A'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Logs Tab */}
          <TabsContent value="logs">
            <Card>
              <CardHeader>
                <CardTitle>Sync Logs</CardTitle>
                <CardDescription>Recent synchronization activity</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {syncLogsData?.data.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="font-medium capitalize">{log.syncType}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              log.status === 'completed'
                                ? 'default'
                                : log.status === 'failed'
                                ? 'destructive'
                                : 'secondary'
                            }
                          >
                            {log.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{new Date(log.startedAt).toLocaleString()}</TableCell>
                        <TableCell>
                          {log.completedAt ? new Date(log.completedAt).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell>
                          {log.errorMessage || JSON.stringify(log.details)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* User Links Tab */}
          <TabsContent value="user-links">
            <div className="space-y-4">
              {/* Actions Bar */}
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>User Links Management</CardTitle>
                    <CardDescription>
                      Manage links between Telegram users and Remnawave profiles
                    </CardDescription>
                  </div>
                  <Button
                    onClick={() => syncAllUsersMutation.mutate()}
                    disabled={syncAllUsersMutation.isPending}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${syncAllUsersMutation.isPending ? 'animate-spin' : ''}`} />
                    {syncAllUsersMutation.isPending ? 'Syncing...' : 'Sync All Users'}
                  </Button>
                </CardHeader>
                <CardContent>
                  {/* Search by Telegram ID */}
                  <div className="flex gap-2 mb-4">
                    <div className="flex-1">
                      <Input
                        placeholder="Search by Telegram ID..."
                        value={telegramSearchQuery}
                        onChange={(e) => setTelegramSearchQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSearchByTelegram()}
                      />
                    </div>
                    <Button
                      onClick={handleSearchByTelegram}
                      disabled={searchUsersMutation.isPending}
                      variant="secondary"
                    >
                      <Search className="h-4 w-4 mr-2" />
                      Search
                    </Button>
                  </div>

                  {/* Sync Report */}
                  {syncAllUsersMutation.data && (
                    <div className="mb-4 p-4 bg-muted rounded-lg">
                      <h4 className="font-semibold mb-2">Last Sync Report</h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-muted-foreground">Total Processed:</span>
                          <p className="font-medium">{syncAllUsersMutation.data.data.report.totalProcessed}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Linked:</span>
                          <p className="font-medium text-green-600">{syncAllUsersMutation.data.data.report.linked}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Created:</span>
                          <p className="font-medium text-blue-600">{syncAllUsersMutation.data.data.report.created}</p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Duration:</span>
                          <p className="font-medium">{syncAllUsersMutation.data.data.report.durationMs}ms</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* User Links Table */}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Telegram ID</TableHead>
                        <TableHead>Remnawave Username</TableHead>
                        <TableHead>UUID</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="w-[150px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {userLinksLoading ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center">Loading...</TableCell>
                        </TableRow>
                      ) : userLinksData?.data.data.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground">
                            No user links found. Click "Sync All Users" to import from Remnawave.
                          </TableCell>
                        </TableRow>
                      ) : (
                        userLinksData?.data.data.map((link) => (
                          <TableRow key={link.id}>
                            <TableCell className="font-medium">{link.telegramId}</TableCell>
                            <TableCell>{link.remnawaveUsername || '-'}</TableCell>
                            <TableCell className="font-mono text-xs">{link.remnawaveUuid.slice(0, 8)}...</TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {link.isPrimary && (
                                  <Badge variant="default" className="gap-1">
                                    <Star className="h-3 w-3" />
                                    Primary
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>{new Date(link.createdAt).toLocaleDateString()}</TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {!link.isPrimary && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setPrimaryLinkMutation.mutate({ linkId: link.id, userId: link.userId })}
                                    disabled={setPrimaryLinkMutation.isPending}
                                    title="Set as Primary"
                                  >
                                    <Star className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleOpenLinkDialog(link.remnawaveUuid)}
                                  title="Link to different Telegram"
                                >
                                  <Link2 className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => deleteLinkMutation.mutate(link.id)}
                                  disabled={deleteLinkMutation.isPending}
                                  title="Delete Link"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>

                  {/* Pagination */}
                  {userLinksData && userLinksData.data.totalPages > 1 && (
                    <div className="flex justify-center gap-2 mt-4">
                      {Array.from({ length: userLinksData.data.totalPages }, (_, i) => (
                        <Button
                          key={i + 1}
                          variant={userLinksData.data.page === i + 1 ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => {/* TODO: Implement pagination */}}
                        >
                          {i + 1}
                        </Button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Link Telegram Dialog */}
      <Dialog open={isLinkDialogOpen} onOpenChange={setIsLinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Telegram ID</DialogTitle>
            <DialogDescription>
              Link a Telegram ID to this Remnawave profile
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="telegramId">Telegram ID</Label>
              <Input
                id="telegramId"
                placeholder="Enter Telegram ID (numbers only)"
                value={linkTelegramId}
                onChange={(e) => setLinkTelegramId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Enter the numeric Telegram ID to link to this profile
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsLinkDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleLinkTelegram}
              disabled={linkTelegramMutation.isPending}
            >
              {linkTelegramMutation.isPending ? 'Linking...' : 'Link Telegram'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
