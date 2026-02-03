import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Plus,
  MailOpen,
  Trash2,
  Search,
  Filter,
  Send,
  Globe,
  CheckCircle2,
  AlertCircle,
  CreditCard,
  Users,
  Gift,
  Shield,
  Megaphone,
  Loader2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { notificationsService, type NotificationType } from '@/api/notifications.service';
import type { Notification, CreateNotificationInput, SendNotificationInput } from '@/api/notifications.service';

const NOTIFICATION_TYPES: { value: NotificationType; label: string; icon: React.ElementType }[] = [
  { value: 'system', label: 'System', icon: CheckCircle2 },
  { value: 'subscription', label: 'Subscription', icon: CreditCard },
  { value: 'payment', label: 'Payment', icon: CreditCard },
  { value: 'promocode', label: 'Promocode', icon: Gift },
  { value: 'referral', label: 'Referral', icon: Users },
  { value: 'partner', label: 'Partner', icon: Users },
  { value: 'security', label: 'Security', icon: Shield },
  { value: 'announcement', label: 'Announcement', icon: Megaphone },
];

const TYPE_COLORS: Record<NotificationType, string> = {
  system: 'bg-blue-500',
  subscription: 'bg-purple-500',
  payment: 'bg-green-500',
  promocode: 'bg-pink-500',
  referral: 'bg-orange-500',
  partner: 'bg-indigo-500',
  security: 'bg-red-500',
  announcement: 'bg-yellow-500',
};

export default function NotificationsPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isSendToUserDialogOpen, setIsSendToUserDialogOpen] = useState(false);
  const [filters, setFilters] = useState<{
    userId?: string;
    type?: NotificationType | '';
    isRead?: 'true' | 'false' | 'all';
    searchTerm?: string;
  }>({
    isRead: 'all',
  });

  // Form state for creating notifications
  const [notificationType, setNotificationType] = useState<NotificationType>('system');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [recipientUserId, setRecipientUserId] = useState('');

  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications', filters],
    queryFn: () =>
      notificationsService.listNotifications({
        page: 1,
        limit: 50,
        userId: filters.userId,
        type: filters.type || undefined,
        isRead: filters.isRead === 'true' ? true : filters.isRead === 'false' ? false : undefined,
      }),
  });

  const { data: statistics } = useQuery({
    queryKey: ['notificationsStats'],
    queryFn: () => notificationsService.getStatistics(),
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateNotificationInput) => notificationsService.createNotification(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notificationsStats'] });
      alert('Notification created successfully');
      setIsCreateDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const sendToUserMutation = useMutation({
    mutationFn: (data: SendNotificationInput) => notificationsService.sendNotification(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notificationsStats'] });
      alert('Notification sent to user');
      setIsSendToUserDialogOpen(false);
      resetSendForm();
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const sendGlobalMutation = useMutation({
    mutationFn: (data: { type: NotificationType; title: string; message: string; linkUrl?: string }) =>
      notificationsService.sendGlobalNotification(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notificationsStats'] });
      alert('Global notification sent successfully');
      setIsCreateDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const markAsReadMutation = useMutation({
    mutationFn: (ids: string[]) => notificationsService.markAsRead({ notificationIds: ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notificationsStats'] });
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => notificationsService.deleteNotification(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notificationsStats'] });
      alert('Notification deleted successfully');
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const resetForm = () => {
    setNotificationType('system');
    setTitle('');
    setMessage('');
    setLinkUrl('');
  };

  const resetSendForm = () => {
    setNotificationType('system');
    setTitle('');
    setMessage('');
    setLinkUrl('');
    setRecipientUserId('');
  };

  const handleCreate = () => {
    sendGlobalMutation.mutate({ type: notificationType, title, message, linkUrl: linkUrl || undefined });
  };

  const handleSendToUser = () => {
    sendToUserMutation.mutate({
      userId: recipientUserId,
      type: notificationType,
      title,
      message,
      linkUrl: linkUrl || undefined,
    });
  };

  const filteredNotifications =
    notifications?.data.filter((notification: Notification) => {
      if (filters.searchTerm) {
        const search = filters.searchTerm.toLowerCase();
        return (
          notification.title.toLowerCase().includes(search) ||
          notification.message.toLowerCase().includes(search) ||
          (notification.userId?.toLowerCase().includes(search) ?? false)
        );
      }
      return true;
    }) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="text-muted-foreground">Manage user notifications and send messages</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={isSendToUserDialogOpen} onOpenChange={setIsSendToUserDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <MailOpen className="mr-2 h-4 w-4" />
                Send to User
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Send Notification to User</DialogTitle>
                <DialogDescription>Send a notification to a specific user</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>User ID</Label>
                  <Input
                    value={recipientUserId}
                    onChange={e => setRecipientUserId(e.target.value)}
                    placeholder="Enter user ID"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <select
                    value={notificationType}
                    onChange={e => setNotificationType(e.target.value as NotificationType)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  >
                    {NOTIFICATION_TYPES.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Notification title" />
                </div>
                <div className="space-y-2">
                  <Label>Message</Label>
                  <Textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="Notification message"
                    rows={4}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Link URL (optional)</Label>
                  <Input
                    value={linkUrl}
                    onChange={e => setLinkUrl(e.target.value)}
                    placeholder="https://example.com"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsSendToUserDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSendToUser}
                  disabled={!recipientUserId || !title || !message || sendToUserMutation.isPending}
                >
                  {sendToUserMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Send className="mr-2 h-4 w-4" />
                  Send Notification
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Notification
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create Global Notification</DialogTitle>
                <DialogDescription>Create a new notification for all users</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <select
                    value={notificationType}
                    onChange={e => setNotificationType(e.target.value as NotificationType)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2"
                  >
                    {NOTIFICATION_TYPES.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Notification title" />
                </div>
                <div className="space-y-2">
                  <Label>Message</Label>
                  <Textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="Notification message"
                    rows={4}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Link URL (optional)</Label>
                  <Input
                    value={linkUrl}
                    onChange={e => setLinkUrl(e.target.value)}
                    placeholder="https://example.com"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!title || !message || createMutation.isPending || sendGlobalMutation.isPending}
                >
                  {(createMutation.isPending || sendGlobalMutation.isPending) && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  <Globe className="mr-2 h-4 w-4" />
                  Send to All Users
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Notifications</CardTitle>
            <Bell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.total || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unread</CardTitle>
            <MailOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.unread || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Read</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.read || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{statistics?.byType?.system || 0}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by title, message, or user ID..."
                  value={filters.searchTerm || ''}
                  onChange={e => setFilters({ ...filters, searchTerm: e.target.value })}
                  className="pl-9"
                />
              </div>
            </div>
            <div className="w-[180px]">
              <select
                value={filters.type}
                onChange={e =>
                  setFilters({ ...filters, type: (e.target.value as NotificationType | '') || undefined })
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="">All Types</option>
                {NOTIFICATION_TYPES.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-[150px]">
              <select
                value={filters.isRead}
                onChange={e => setFilters({ ...filters, isRead: e.target.value as 'true' | 'false' | 'all' })}
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
                <option value="all">All Status</option>
                <option value="false">Unread</option>
                <option value="true">Read</option>
              </select>
            </div>
            <Button
              variant="outline"
              onClick={() => setFilters({ isRead: 'all' })}
              className="shrink-0"
            >
              <X className="mr-2 h-4 w-4" />
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Notifications Table */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>View and manage user notifications</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredNotifications.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No notifications found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredNotifications.map((notification: Notification) => (
                    <TableRow key={notification.id}>
                      <TableCell>
                        {notification.isRead ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        ) : (
                          <div className="h-2 w-2 rounded-full bg-blue-500" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={TYPE_COLORS[notification.type]}>{notification.type}</Badge>
                      </TableCell>
                      <TableCell>
                        {notification.userId ? (
                          <span className="text-sm font-mono truncate max-w-[100px] inline-block">
                            {notification.userId.slice(0, 8)}...
                          </span>
                        ) : (
                          <Badge variant="secondary">
                            <Globe className="mr-1 h-3 w-3" />
                            Global
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-medium max-w-[150px] truncate">
                        {notification.title}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-muted-foreground">
                        {notification.message}
                      </TableCell>
                      <TableCell>{new Date(notification.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {!notification.isRead && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => markAsReadMutation.mutate([notification.id])}
                              disabled={markAsReadMutation.isPending}
                            >
                              <MailOpen className="h-4 w-4" />
                            </Button>
                          )}
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete Notification</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Are you sure you want to delete this notification? This action cannot
                                  be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteMutation.mutate(notification.id)}
                                  className="bg-red-500 hover:bg-red-600"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
