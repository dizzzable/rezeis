import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, X, RotateCcw, Loader2, LifeBuoy } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface TicketMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  content: string;
  createdAt: string;
}

interface Ticket {
  id: string;
  userTelegramId: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  user?: { username: string | null; name: string; telegramId: string };
  messages: TicketMessage[];
}

function statusBadge(status: string, t: (key: string) => string) {
  if (status === 'open') return <Badge variant="warning">{t('supportTicketsPage.statuses.open')}</Badge>;
  if (status === 'closed') return <Badge variant="secondary">{t('supportTicketsPage.statuses.closed')}</Badge>;
  return <Badge variant="success">{t('supportTicketsPage.statuses.waitingReply')}</Badge>;
}

export default function SupportTicketsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('open');
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['support-tickets', statusFilter],
    queryFn: async () => {
      const params: Record<string, string> = { limit: '100' };
      if (statusFilter !== 'all') params.status = statusFilter;
      return (await api.get<{ items: Ticket[]; total: number }>('/admin/support-tickets', { params })).data;
    },
    placeholderData: keepPreviousData,
  });

  const { data: ticketDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['support-ticket', selectedTicket],
    queryFn: async () => (await api.get<Ticket>(`/admin/support-tickets/${selectedTicket}`)).data,
    enabled: !!selectedTicket,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const replyMutation = useMutation({
    mutationFn: (content: string) => api.post(`/admin/support-tickets/${selectedTicket}/reply`, { content }),
    onSuccess: () => {
      setReplyText('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket', selectedTicket] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success(t('supportTicketsPage.toast.replySent'));
    },
    onError: () => toast.error(t('supportTicketsPage.toast.replyFailed')),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.post(`/admin/support-tickets/${selectedTicket}/close`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket', selectedTicket] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success(t('supportTicketsPage.toast.closed'));
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => api.post(`/admin/support-tickets/${selectedTicket}/reopen`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket', selectedTicket] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success(t('supportTicketsPage.toast.reopened'));
    },
  });

  // Two-panel layout: list + detail
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <LifeBuoy className="h-6 w-6" />
            {t('supportTicketsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('supportTicketsPage.subtitle')}</p>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-36" aria-label={t('supportTicketsPage.filters.status')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('supportTicketsPage.filters.all')}</SelectItem>
            <SelectItem value="open">{t('supportTicketsPage.filters.open')}</SelectItem>
            <SelectItem value="waiting_reply">{t('supportTicketsPage.filters.waiting')}</SelectItem>
            <SelectItem value="closed">{t('supportTicketsPage.filters.closed')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:min-h-[600px]">
        {/* Ticket list */}
        <div className="lg:col-span-4 space-y-2 overflow-y-auto lg:max-h-[700px]">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-muted-foreground">
              <MessageSquare className="h-10 w-10 opacity-30" />
              <p>{t('supportTicketsPage.list.empty')}</p>
            </div>
          ) : (
            data.items.map((ticket) => (
              <button
                key={ticket.id}
                onClick={() => setSelectedTicket(ticket.id)}
                className={cn(
                  'w-full text-left rounded-lg border p-3 transition-colors',
                  selectedTicket === ticket.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/50',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-sm truncate">{ticket.subject}</p>
                  {statusBadge(ticket.status, t)}
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-muted-foreground">
                    {ticket.user?.username ?? ticket.user?.name ?? ticket.userTelegramId}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatDateTime(ticket.updatedAt)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Ticket detail */}
        <div className="lg:col-span-8">
          {!selectedTicket ? (
            <Card className="h-full flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <MessageSquare className="h-12 w-12 mx-auto opacity-20 mb-3" />
                <p>{t('supportTicketsPage.detail.selectPrompt')}</p>
              </div>
            </Card>
          ) : detailLoading ? (
            <Card className="h-full flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </Card>
          ) : ticketDetail ? (
            <Card className="h-full flex flex-col">
              {/* Header */}
              <CardHeader className="pb-3 border-b">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{ticketDetail.subject}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {ticketDetail.user?.username ? `@${ticketDetail.user.username}` : ticketDetail.user?.name} · {t('supportTicketsPage.detail.tgPrefix')}: {ticketDetail.userTelegramId}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(ticketDetail.status, t)}
                    {ticketDetail.status !== 'closed' ? (
                      <Button variant="ghost" size="sm" onClick={() => closeMutation.mutate()}>
                        <X className="h-4 w-4 mr-1" /> {t('supportTicketsPage.detail.close')}
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => reopenMutation.mutate()}>
                        <RotateCcw className="h-4 w-4 mr-1" /> {t('supportTicketsPage.detail.reopen')}
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              {/* Messages */}
              <CardContent className="flex-1 overflow-y-auto py-4 space-y-3 max-h-[400px]">
                {ticketDetail.messages.map((msg) => {
                  const isAdmin = msg.authorType === 'admin';
                  return (
                    <div key={msg.id} className={cn('flex', isAdmin ? 'justify-end' : 'justify-start')}>
                      <div className={cn(
                        'max-w-[75%] rounded-2xl px-4 py-2.5',
                        isAdmin ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted rounded-bl-sm',
                      )}>
                        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                        <p className={cn('text-[10px] mt-1', isAdmin ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
                          {formatDateTime(msg.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>

              {/* Reply input */}
              {ticketDetail.status !== 'closed' && (
                <div className="p-4 border-t">
                  <div className="flex gap-2">
                    <Textarea
                      aria-label={t('supportTicketsPage.detail.replyLabel')}
                      placeholder={t('supportTicketsPage.detail.replyPlaceholder')}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      className="min-h-[60px] resize-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (replyText.trim()) replyMutation.mutate(replyText.trim());
                        }
                      }}
                    />
                    <Button
                      onClick={() => replyText.trim() && replyMutation.mutate(replyText.trim())}
                      disabled={!replyText.trim() || replyMutation.isPending}
                      className="shrink-0"
                      aria-label={t('supportTicketsPage.detail.sendReply')}
                    >
                      {replyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">{t('supportTicketsPage.detail.keyHint')}</p>
                </div>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
