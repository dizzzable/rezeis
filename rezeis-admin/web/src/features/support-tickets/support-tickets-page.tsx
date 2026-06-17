import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare,
  Send,
  X,
  RotateCcw,
  Loader2,
  LifeBuoy,
  Paperclip,
  FileText,
  UserX,
  Download,
  Settings,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface TicketAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface TicketMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  content: string;
  createdAt: string;
  metadata?: unknown;
  attachments?: TicketAttachment[];
}

interface TicketDocRequest {
  id: string;
  kind: string;
  label: string;
  status: string;
  fulfilledMessageId: string | null;
  createdAt: string;
}

interface Ticket {
  id: string;
  userTelegramId: string | null;
  subject: string;
  status: string;
  channel: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user?: { username: string | null; name: string; telegramId: string } | null;
  guest?: { id: string; email: string | null; displayName: string | null } | null;
  messages: TicketMessage[];
  docRequests?: TicketDocRequest[];
}

const DOC_KINDS = ['PAYMENT_PROOF', 'DOCUMENT', 'LOGIN', 'OTHER'] as const;

function statusBadge(status: string, t: (key: string) => string) {
  if (status === 'open') return <Badge variant="warning">{t('supportTicketsPage.statuses.open')}</Badge>;
  if (status === 'closed') return <Badge variant="secondary">{t('supportTicketsPage.statuses.closed')}</Badge>;
  return <Badge variant="success">{t('supportTicketsPage.statuses.waitingReply')}</Badge>;
}

/** A guest ticket has no account; show an anonymous marker, never a @username. */
function isGuest(ticket: Pick<Ticket, 'channel'>): boolean {
  return ticket.channel === 'guest';
}

export default function SupportTicketsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState('open');
  const [channelFilter, setChannelFilter] = useState('all');
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [configOpen, setConfigOpen] = useState(false);

  // Deep-link: a push notification opens `/support-tickets?ticket=<id>` — show
  // all statuses so the target is found, and auto-select it.
  useEffect(() => {
    const ticketId = searchParams.get('ticket');
    if (ticketId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync deep-link query param into selection state
      setSelectedTicket(ticketId);
      setStatusFilter('all');
    }
  }, [searchParams]);

  const { data, isLoading } = useQuery({
    queryKey: ['support-tickets', statusFilter, channelFilter],
    queryFn: async () => {
      const params: Record<string, string> = { limit: '100' };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (channelFilter !== 'all') params.channel = channelFilter;
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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['support-ticket', selectedTicket] });
    queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
  };

  const replyMutation = useMutation({
    mutationFn: (content: string) => api.post(`/admin/support-tickets/${selectedTicket}/reply`, { content }),
    onSuccess: () => {
      setReplyText('');
      invalidate();
      toast.success(t('supportTicketsPage.toast.replySent'));
    },
    onError: () => toast.error(t('supportTicketsPage.toast.replyFailed')),
  });

  const closeMutation = useMutation({
    mutationFn: () => api.post(`/admin/support-tickets/${selectedTicket}/close`),
    onSuccess: () => {
      invalidate();
      toast.success(t('supportTicketsPage.toast.closed'));
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => api.post(`/admin/support-tickets/${selectedTicket}/reopen`),
    onSuccess: () => {
      invalidate();
      toast.success(t('supportTicketsPage.toast.reopened'));
    },
  });

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
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setConfigOpen(true)}
            className="gap-1.5"
            aria-label={t('supportTicketsPage.config.open')}
          >
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">{t('supportTicketsPage.config.open')}</span>
          </Button>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="w-full sm:w-40" aria-label={t('supportTicketsPage.filters.channel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('supportTicketsPage.filters.channelAll')}</SelectItem>
              <SelectItem value="cabinet">{t('supportTicketsPage.filters.cabinet')}</SelectItem>
              <SelectItem value="guest">{t('supportTicketsPage.filters.guest')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-36" aria-label={t('supportTicketsPage.filters.status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('supportTicketsPage.filters.all')}</SelectItem>
              <SelectItem value="open">{t('supportTicketsPage.filters.open')}</SelectItem>
              <SelectItem value="waiting_reply">{t('supportTicketsPage.filters.waiting')}</SelectItem>
              <SelectItem value="closed">{t('supportTicketsPage.filters.closed')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
                  {isGuest(ticket) ? (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <UserX className="h-3 w-3" />
                      {t('supportTicketsPage.list.guestBadge')}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground truncate">
                      {ticket.user?.username ?? ticket.user?.name ?? ticket.userTelegramId}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">
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
            <TicketDetail
              ticket={ticketDetail}
              replyText={replyText}
              onReplyTextChange={setReplyText}
              onReply={() => replyText.trim() && replyMutation.mutate(replyText.trim())}
              replyPending={replyMutation.isPending}
              onClose={() => closeMutation.mutate()}
              onReopen={() => reopenMutation.mutate()}
              onChanged={invalidate}
            />
          ) : null}
        </div>
      </div>

      <SupportConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
    </div>
  );
}

interface TicketDetailProps {
  ticket: Ticket;
  replyText: string;
  onReplyTextChange: (value: string) => void;
  onReply: () => void;
  replyPending: boolean;
  onClose: () => void;
  onReopen: () => void;
  onChanged: () => void;
}

function TicketDetail({
  ticket,
  replyText,
  onReplyTextChange,
  onReply,
  replyPending,
  onClose,
  onReopen,
  onChanged,
}: TicketDetailProps) {
  const { t } = useTranslation();
  const guest = isGuest(ticket);
  const contact = ticket.guest?.email ?? ticket.guest?.displayName ?? null;
  const isClosed = ticket.status === 'closed';

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3 border-b">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              {ticket.subject}
              {guest && (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <UserX className="h-3 w-3" />
                  {t('supportTicketsPage.detail.guestBadge')}
                </Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {guest
                ? `${t('supportTicketsPage.detail.guestContact')}: ${contact ?? t('supportTicketsPage.detail.noContact')}`
                : `${ticket.user?.username ? `@${ticket.user.username}` : ticket.user?.name ?? ''} · ${t('supportTicketsPage.detail.tgPrefix')}: ${ticket.userTelegramId ?? '—'}`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {statusBadge(ticket.status, t)}
            {!isClosed ? (
              <Button variant="ghost" size="sm" onClick={onClose}>
                <X className="h-4 w-4 mr-1" /> {t('supportTicketsPage.detail.close')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={onReopen}>
                <RotateCcw className="h-4 w-4 mr-1" /> {t('supportTicketsPage.detail.reopen')}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-y-auto py-4 space-y-3 max-h-[400px]">
        {ticket.messages.map((msg) => (
          <MessageBubble key={msg.id} ticketId={ticket.id} message={msg} />
        ))}
      </CardContent>

      {!isClosed && (
        <div className="border-t p-4 space-y-3">
          <DocRequestForm ticketId={ticket.id} onChanged={onChanged} />
          <div className="flex gap-2">
            <Textarea
              aria-label={t('supportTicketsPage.detail.replyLabel')}
              placeholder={t('supportTicketsPage.detail.replyPlaceholder')}
              value={replyText}
              onChange={(e) => onReplyTextChange(e.target.value)}
              className="min-h-[60px] resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onReply();
                }
              }}
            />
            <div className="flex flex-col gap-2 shrink-0">
              <Button
                onClick={onReply}
                disabled={!replyText.trim() || replyPending}
                aria-label={t('supportTicketsPage.detail.sendReply')}
              >
                {replyPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
              <AttachmentUpload ticketId={ticket.id} onChanged={onChanged} />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">{t('supportTicketsPage.detail.keyHint')}</p>
        </div>
      )}
    </Card>
  );
}

function MessageBubble({ ticketId, message }: { ticketId: string; message: TicketMessage }) {
  const { t } = useTranslation();
  if (message.authorType === 'system') {
    return (
      <div className="flex justify-center">
        <div className="max-w-[85%] rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-center">
          <p className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 flex items-center justify-center gap-1">
            <FileText className="h-3 w-3" />
            {t('supportTicketsPage.docRequest.badge')}
          </p>
          <p className="text-sm mt-1 whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }
  const isAdmin = message.authorType === 'admin';
  return (
    <div className={cn('flex', isAdmin ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-2.5',
          isAdmin ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted rounded-bl-sm',
        )}
      >
        {message.content && <p className="text-sm whitespace-pre-wrap">{message.content}</p>}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.attachments.map((att) => (
              <AttachmentChip key={att.id} ticketId={ticketId} attachment={att} />
            ))}
          </div>
        )}
        <p className={cn('text-[10px] mt-1', isAdmin ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
          {formatDateTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

function AttachmentChip({ ticketId, attachment }: { ticketId: string; attachment: TicketAttachment }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    try {
      const res = await api.get<Blob>(
        `/admin/support-tickets/${ticketId}/attachments/${attachment.id}`,
        { responseType: 'blob' },
      );
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      disabled={loading}
      aria-label={t('supportTicketsPage.detail.downloadAttachment')}
      className="flex items-center gap-1.5 text-xs underline underline-offset-2 hover:opacity-80"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      <span className="truncate max-w-[180px]">{attachment.filename}</span>
    </button>
  );
}

function DocRequestForm({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>('PAYMENT_PROOF');
  const [label, setLabel] = useState('');

  const kindLabel = (k: string): string => {
    switch (k) {
      case 'PAYMENT_PROOF':
        return t('supportTicketsPage.docRequest.kindPaymentProof');
      case 'DOCUMENT':
        return t('supportTicketsPage.docRequest.kindDocument');
      case 'LOGIN':
        return t('supportTicketsPage.docRequest.kindLogin');
      default:
        return t('supportTicketsPage.docRequest.kindOther');
    }
  };

  const mutation = useMutation({
    mutationFn: () => api.post(`/admin/support-tickets/${ticketId}/document-request`, { kind, label: label.trim() }),
    onSuccess: () => {
      setLabel('');
      setOpen(false);
      onChanged();
      toast.success(t('supportTicketsPage.toast.docRequested'));
    },
    onError: () => toast.error(t('supportTicketsPage.toast.docRequestFailed')),
  });

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="gap-1.5">
        <FileText className="h-4 w-4" />
        {t('supportTicketsPage.docRequest.title')}
      </Button>
    );
  }

  return (
    <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
      <div className="flex gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-44" aria-label={t('supportTicketsPage.docRequest.kind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOC_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {kindLabel(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t('supportTicketsPage.docRequest.label')}
          placeholder={t('supportTicketsPage.docRequest.labelPlaceholder')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          disabled={!label.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t('supportTicketsPage.docRequest.send')}
        </Button>
      </div>
    </div>
  );
}

function AttachmentUpload({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = async (file: File) => {
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.post(`/admin/support-tickets/${ticketId}/attachments`, {
        filename: file.name,
        mimeType: file.type || undefined,
        dataBase64,
      });
      onChanged();
      toast.success(t('supportTicketsPage.toast.attachmentUploaded'));
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 413) toast.error(t('supportTicketsPage.toast.attachmentTooLarge'));
      else if (status === 415) toast.error(t('supportTicketsPage.toast.attachmentType'));
      else toast.error(t('supportTicketsPage.toast.attachmentFailed'));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        aria-label={t('supportTicketsPage.detail.attach')}
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
      </Button>
    </>
  );
}

/** Read a File into raw base64 (without the data: URI prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma !== -1 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}


interface SupportConfig {
  enabled: boolean;
  guestTokenTtlHours: number;
  attachmentMaxMb: number;
  attachmentMaxPerMsg: number;
  turnstileSiteKey: string;
  turnstileConfigured: boolean;
}

function SupportConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SupportConfig | null>(null);
  const [secret, setSecret] = useState('');

  const { data } = useQuery({
    queryKey: ['support-config'],
    queryFn: async () => (await api.get<SupportConfig>('/admin/support-tickets/config')).data,
    enabled: open,
  });

  useEffect(() => {
    if (data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the editable draft from the loaded config
      setDraft(data);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (value: SupportConfig) => {
      const payload: Record<string, unknown> = {
        enabled: value.enabled,
        guestTokenTtlHours: value.guestTokenTtlHours,
        attachmentMaxMb: value.attachmentMaxMb,
        attachmentMaxPerMsg: value.attachmentMaxPerMsg,
        turnstileSiteKey: value.turnstileSiteKey,
      };
      // Only send the secret when the operator typed one (empty = keep as-is).
      if (secret.trim().length > 0) payload.turnstileSecret = secret.trim();
      return (await api.post('/admin/support-tickets/config', payload)).data;
    },
    onSuccess: () => {
      setSecret('');
      queryClient.invalidateQueries({ queryKey: ['support-config'] });
      toast.success(t('supportTicketsPage.config.saved'));
      onOpenChange(false);
    },
    onError: () => toast.error(t('supportTicketsPage.config.saveFailed')),
  });

  const patch = (next: Partial<SupportConfig>) =>
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('supportTicketsPage.config.title')}</DialogTitle>
          <DialogDescription>{t('supportTicketsPage.config.description')}</DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="support-enabled">{t('supportTicketsPage.config.enabled')}</Label>
              <Switch
                id="support-enabled"
                checked={draft.enabled}
                onCheckedChange={(checked) => patch({ enabled: checked })}
                aria-label={t('supportTicketsPage.config.enabled')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="support-ttl">{t('supportTicketsPage.config.ttl')}</Label>
              <Input
                id="support-ttl"
                type="number"
                min={1}
                max={8760}
                value={draft.guestTokenTtlHours}
                onChange={(e) => patch({ guestTokenTtlHours: Number(e.target.value) })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="support-max-mb">{t('supportTicketsPage.config.maxMb')}</Label>
                <Input
                  id="support-max-mb"
                  type="number"
                  min={1}
                  max={50}
                  value={draft.attachmentMaxMb}
                  onChange={(e) => patch({ attachmentMaxMb: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="support-max-per-msg">{t('supportTicketsPage.config.maxPerMsg')}</Label>
                <Input
                  id="support-max-per-msg"
                  type="number"
                  min={1}
                  max={20}
                  value={draft.attachmentMaxPerMsg}
                  onChange={(e) => patch({ attachmentMaxPerMsg: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="support-site-key">{t('supportTicketsPage.config.turnstileSiteKey')}</Label>
              <Input
                id="support-site-key"
                value={draft.turnstileSiteKey}
                onChange={(e) => patch({ turnstileSiteKey: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="support-secret">
                {t('supportTicketsPage.config.turnstileSecret')}
                {draft.turnstileConfigured && (
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    ({t('supportTicketsPage.config.turnstileConfigured')})
                  </span>
                )}
              </Label>
              <Input
                id="support-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={t('supportTicketsPage.config.secretPlaceholder')}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('supportTicketsPage.config.secretClearHint')}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('supportTicketsPage.config.cancel')}
          </Button>
          <Button
            disabled={!draft || mutation.isPending}
            onClick={() => draft && mutation.mutate(draft)}
          >
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t('supportTicketsPage.config.save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
