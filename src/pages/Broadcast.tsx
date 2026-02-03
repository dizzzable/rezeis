import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Send, Eye, Trash2, Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { broadcastService } from '@/api/broadcast.service';
import type { Broadcast, BroadcastAudience } from '@/types/entity.types';

const AUDIENCE_OPTIONS: { value: BroadcastAudience; label: string }[] = [
  { value: 'ALL', label: 'All Users' },
  { value: 'SUBSCRIBED', label: 'Subscribed Users' },
  { value: 'UNSUBSCRIBED', label: 'Unsubscribed Users' },
  { value: 'EXPIRED', label: 'Expired Subscriptions' },
  { value: 'TRIAL', label: 'Trial Users' },
  { value: 'PLAN', label: 'Specific Plan' },
];

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500',
  pending: 'bg-yellow-500',
  sending: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
};

export default function BroadcastPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);

  // Form state
  const [audience, setAudience] = useState<BroadcastAudience>('ALL');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [telegramId, setTelegramId] = useState('');

  const { data: broadcasts, isLoading } = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => broadcastService.getBroadcasts({ page: 1, limit: 50 }),
  });

  const { data: audienceCount } = useQuery({
    queryKey: ['audience', audience],
    queryFn: () => broadcastService.getAudience({ audience }),
    enabled: !!audience,
  });

  const createMutation = useMutation({
    mutationFn: broadcastService.createBroadcast,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      alert('Broadcast created successfully');
      setIsCreateDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const sendMutation = useMutation({
    mutationFn: (id: string) => broadcastService.sendBroadcast(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      alert('Broadcast started sending');
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const previewMutation = useMutation({
    mutationFn: ({ id, telegramId }: { id: string; telegramId: string }) =>
      broadcastService.previewBroadcast(id, telegramId),
    onSuccess: () => {
      alert('Preview sent successfully');
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: broadcastService.deleteBroadcast,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      alert('Broadcast deleted successfully');
    },
    onError: (error: Error) => {
      alert(`Error: ${error.message}`);
    },
  });

  const resetForm = () => {
    setAudience('ALL');
    setContent('');
    setMediaUrl('');
  };

  const handleCreate = () => {
    createMutation.mutate({
      audience,
      content,
      mediaUrl: mediaUrl || undefined,
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Broadcast</h1>
          <p className="text-muted-foreground">Send mass messages to your users via Telegram</p>
        </div>
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Broadcast
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create New Broadcast</DialogTitle>
              <DialogDescription>Create a new message to send to your users</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {/* Audience Selection */}
              <div className="space-y-2">
                <Label>Target Audience</Label>
                <select
                  value={audience}
                  onChange={(e) => setAudience(e.target.value as BroadcastAudience)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                >
                  {AUDIENCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {audienceCount && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    Estimated recipients: {audienceCount.count}
                  </p>
                )}
              </div>

              {/* Content */}
              <div className="space-y-2">
                <Label>Message Content</Label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Enter your message... (HTML supported)"
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                />
              </div>

              {/* Media URL */}
              <div className="space-y-2">
                <Label>Media URL (optional)</Label>
                <Input
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder="https://example.com/image.jpg"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!content || createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Broadcast
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Broadcasts</CardTitle>
            <Megaphone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{broadcasts?.total || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Draft</CardTitle>
            <div className="h-4 w-4 rounded-full bg-gray-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {broadcasts?.data.filter((b: Broadcast) => b.status === 'draft').length || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sending</CardTitle>
            <div className="h-4 w-4 rounded-full bg-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {broadcasts?.data.filter((b: Broadcast) => b.status === 'sending').length || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <div className="h-4 w-4 rounded-full bg-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {broadcasts?.data.filter((b: Broadcast) => b.status === 'completed').length || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Broadcasts Table */}
      <Card>
        <CardHeader>
          <CardTitle>Broadcast History</CardTitle>
          <CardDescription>View and manage your mass messaging campaigns</CardDescription>
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
                  <TableHead>Audience</TableHead>
                  <TableHead>Content Preview</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {broadcasts?.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No broadcasts yet. Create your first broadcast to get started.
                    </TableCell>
                  </TableRow>
                ) : (
                  broadcasts?.data.map((broadcast: Broadcast) => (
                    <TableRow key={broadcast.id}>
                      <TableCell>
                        <Badge className={STATUS_COLORS[broadcast.status]}>
                          {broadcast.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{broadcast.audience}</TableCell>
                      <TableCell className="max-w-xs truncate">
                        {broadcast.content.slice(0, 50)}...
                      </TableCell>
                      <TableCell>{broadcast.recipientsCount}</TableCell>
                      <TableCell>{broadcast.sentCount}</TableCell>
                      <TableCell>{broadcast.failedCount}</TableCell>
                      <TableCell>
                        {new Date(broadcast.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {/* Preview Dialog */}
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <Eye className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Send Preview</DialogTitle>
                                <DialogDescription>
                                  Send a preview of this broadcast to your Telegram
                                </DialogDescription>
                              </DialogHeader>
                              <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                  <Label>Your Telegram ID</Label>
                                  <Input
                                    value={telegramId}
                                    onChange={(e) => setTelegramId(e.target.value)}
                                    placeholder="123456789"
                                  />
                                </div>
                              </div>
                              <div className="flex justify-end">
                                <Button
                                  onClick={() =>
                                    previewMutation.mutate({ id: broadcast.id, telegramId })
                                  }
                                  disabled={!telegramId || previewMutation.isPending}
                                >
                                  {previewMutation.isPending && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  )}
                                  Send Preview
                                </Button>
                              </div>
                            </DialogContent>
                          </Dialog>

                          {/* Send Button */}
                          {broadcast.status === 'draft' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => sendMutation.mutate(broadcast.id)}
                              disabled={sendMutation.isPending}
                            >
                              <Send className="h-4 w-4" />
                            </Button>
                          )}

                          {/* Delete Button */}
                          {broadcast.status === 'draft' && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <Trash2 className="h-4 w-4 text-red-500" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Delete Broadcast</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to delete this broadcast? This action
                                    cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => deleteMutation.mutate(broadcast.id)}
                                    className="bg-red-500 hover:bg-red-600"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
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
