import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Loader2, Pencil, Plus, RadioTower, RotateCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useHasPermission } from '@/features/rbac'

import { olcrtcApi, type OlcrtcGatewayStatus, type OlcrtcOverview, type OlcrtcProfile, type OlcrtcProvider, type OlcrtcProviderAccount, type OlcrtcRoomStatus, type OlcrtcSessionStatus, type OlcrtcTransport } from './olcrtc-api'

const OVERVIEW_KEY = ['admin', 'olcrtc', 'overview'] as const
const TRAFFIC_KEY = ['admin', 'olcrtc', 'traffic'] as const
const PROVIDERS: readonly OlcrtcProvider[] = ['JITSI', 'TELEMOST', 'WBSTREAM']
const TRANSPORTS: readonly OlcrtcTransport[] = ['VP8CHANNEL', 'DATACHANNEL', 'SEICHANNEL', 'VIDEOCHANNEL']
const GATEWAY_STATUSES: readonly OlcrtcGatewayStatus[] = ['ACTIVE', 'DRAINING', 'DISABLED', 'UNHEALTHY']

export default function OlcrtcPage() {
  const canView = useHasPermission('olcrtc', 'view')
  const canCreate = useHasPermission('olcrtc', 'create')
  const canEdit = useHasPermission('olcrtc', 'edit')
  const canRun = useHasPermission('olcrtc', 'run')
  const queryClient = useQueryClient()
  const [trafficSessionId, setTrafficSessionId] = useState('')
  const [trafficTake, setTrafficTake] = useState('25')
  const normalizedTrafficTake = normalizeTrafficTake(trafficTake)
  const trafficQuery = {
    sessionId: trafficSessionId.trim() === '' ? undefined : trafficSessionId.trim(),
    take: normalizedTrafficTake,
  }

  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: olcrtcApi.getOverview,
    enabled: canView,
    refetchInterval: 30_000,
  })

  const traffic = useQuery({
    queryKey: [...TRAFFIC_KEY, trafficQuery],
    queryFn: () => olcrtcApi.listTrafficLedger(trafficQuery),
    enabled: canView,
    refetchInterval: 30_000,
  })

  const lifecycle = useMutation({
    mutationFn: olcrtcApi.runLifecycle,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success(
        `Lifecycle complete: ${result.staleGateways} gateways, ${result.expiredSessions + result.stuckSessions} sessions, ${result.expiredRooms} rooms updated.`,
      )
    },
    onError: () => toast.error('Lifecycle run failed'),
  })

  if (!canView) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>OLCRTC access denied</CardTitle>
          <CardDescription>Your role cannot view OLCRTC operations.</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <RadioTower className="h-6 w-6" aria-hidden />
            OLCRTC
          </h1>
          <p className="text-muted-foreground">Restricted-network auxiliary access control plane.</p>
        </div>
        <Button onClick={() => lifecycle.mutate()} disabled={!canRun || lifecycle.isPending}>
          {lifecycle.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="mr-2 h-4 w-4" aria-hidden />}
          Run lifecycle
        </Button>
      </div>

      {overview.isError ? (
        <Alert variant="destructive">
          <Activity className="h-4 w-4" aria-hidden />
          <AlertTitle>OLCRTC overview unavailable</AlertTitle>
          <AlertDescription>Check the Rezeis API logs and RBAC permissions.</AlertDescription>
        </Alert>
      ) : null}

      {overview.isLoading ? <OverviewSkeleton /> : overview.data ? <OverviewContent overview={overview.data} canCreate={canCreate} canEdit={canEdit} /> : null}
      {traffic.isLoading ? (
        <Skeleton className="h-64" />
      ) : traffic.data ? (
        <TrafficLedgerCard
          items={traffic.data.items}
          sessionId={trafficSessionId}
          take={trafficTake}
          isRefreshing={traffic.isFetching}
          onSessionIdChange={setTrafficSessionId}
          onTakeChange={setTrafficTake}
          onRefresh={() => void traffic.refetch()}
          onReset={() => {
            setTrafficSessionId('')
            setTrafficTake('25')
          }}
        />
      ) : null}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}
      </div>
      <Skeleton className="h-72" />
    </div>
  )
}

function OverviewContent({ overview, canCreate, canEdit }: { readonly overview: OlcrtcOverview; readonly canCreate: boolean; readonly canEdit: boolean }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Gateways" value={overview.counts.gateways ?? 0} detail={`${overview.counts.activeGateways ?? 0} active`} />
        <MetricCard label="Sessions" value={overview.counts.sessions ?? 0} detail={`${overview.counts.activeSessions ?? 0} active`} />
        <MetricCard label="Rooms" value={overview.counts.rooms ?? 0} detail={`${overview.counts.inUseRooms ?? 0} in use`} />
        <MetricCard label="Traffic rows" value={overview.counts.trafficLedger ?? 0} detail="ledger entries" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <ProviderAccountsCard overview={overview} canEdit={canEdit} />
          <ProfilesCard overview={overview} canEdit={canEdit} />
          <GatewaysCard overview={overview} canEdit={canEdit} />
          <RoomsCard overview={overview} canEdit={canEdit} />
          <SessionsCard overview={overview} canEdit={canEdit} />
        </div>
        <div className="space-y-6">
          <CreateProviderAccountCard canCreate={canCreate} />
          <CreateProfileCard overview={overview} canCreate={canCreate} />
        </div>
      </div>
    </div>
  )
}

function MetricCard({ label, value, detail }: { readonly label: string; readonly value: number; readonly detail: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}

function ProviderAccountsCard({ overview, canEdit }: { readonly overview: OlcrtcOverview; readonly canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<OlcrtcProviderAccount | null>(null)
  const update = useMutation({
    mutationFn: ({ id, isEnabled }: { readonly id: string; readonly isEnabled: boolean }) => olcrtcApi.updateProviderAccount(id, { isEnabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Provider account updated')
    },
    onError: () => toast.error('Provider account update failed'),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" aria-hidden /> Provider accounts</CardTitle>
        <CardDescription>Credentials are write-only and never returned to the browser.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Name</TableHead><TableHead>Provider</TableHead><TableHead>Hint</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {overview.providerAccounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell className="font-medium">{account.name}</TableCell>
                <TableCell>{account.provider}</TableCell>
                <TableCell className="text-muted-foreground">{account.credentialHint ?? 'none'}</TableCell>
                <TableCell><StatusBadge status={account.isEnabled ? 'ENABLED' : 'DISABLED'} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Switch
                      checked={account.isEnabled}
                      disabled={!canEdit || update.isPending}
                      onCheckedChange={(isEnabled) => update.mutate({ id: account.id, isEnabled })}
                      aria-label={`Toggle ${account.name}`}
                    />
                    <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setEditing(account)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden /> Edit
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {overview.providerAccounts.length === 0 ? <EmptyRow colSpan={5} label="No provider accounts yet" /> : null}
          </TableBody>
        </Table>
        {editing ? <ProviderAccountEditForm account={editing} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} /> : null}
      </CardContent>
    </Card>
  )
}

function ProfilesCard({ overview, canEdit }: { readonly overview: OlcrtcOverview; readonly canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<OlcrtcProfile | null>(null)
  const update = useMutation({
    mutationFn: ({ id, isEnabled }: { readonly id: string; readonly isEnabled: boolean }) => olcrtcApi.updateProfile(id, { isEnabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Profile updated')
    },
    onError: () => toast.error('Profile update failed'),
  })

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Profiles</CardTitle><CardDescription>Provisioning choices ordered by priority.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Provider</TableHead><TableHead>Transport</TableHead><TableHead>Priority</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {overview.profiles.map((profile) => (
              <TableRow key={profile.id}>
                <TableCell className="font-medium">{profile.name}</TableCell>
                <TableCell>{profile.provider}</TableCell>
                <TableCell>{profile.transport}</TableCell>
                <TableCell>{profile.priority}</TableCell>
                <TableCell><StatusBadge status={profile.isEnabled ? 'ENABLED' : 'DISABLED'} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Switch
                      checked={profile.isEnabled}
                      disabled={!canEdit || update.isPending}
                      onCheckedChange={(isEnabled) => update.mutate({ id: profile.id, isEnabled })}
                      aria-label={`Toggle ${profile.name}`}
                    />
                    <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setEditing(profile)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden /> Edit
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {overview.profiles.length === 0 ? <EmptyRow colSpan={6} label="No profiles configured" /> : null}
          </TableBody>
        </Table>
        {editing ? <ProfileEditForm profile={editing} overview={overview} onCancel={() => setEditing(null)} onSaved={() => setEditing(null)} /> : null}
      </CardContent>
    </Card>
  )
}

function GatewaysCard({ overview, canEdit }: { readonly overview: OlcrtcOverview; readonly canEdit: boolean }) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: ({ id, status }: { readonly id: string; readonly status: OlcrtcGatewayStatus }) => olcrtcApi.updateGateway(id, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Gateway updated')
    },
    onError: () => toast.error('Gateway update failed'),
  })

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Gateways</CardTitle><CardDescription>Agent daemons currently known by the control plane.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Load</TableHead><TableHead>Last seen</TableHead><TableHead className="text-right">Operator state</TableHead></TableRow></TableHeader>
          <TableBody>
            {overview.gateways.map((gateway) => (
              <TableRow key={gateway.id}>
                <TableCell className="font-medium">{gateway.name}</TableCell>
                <TableCell><StatusBadge status={gateway.status} /></TableCell>
                <TableCell>{gateway.activeSessions}/{gateway.capacity}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(gateway.lastSeenAt)}</TableCell>
                <TableCell className="text-right">
                  <select
                    value={gateway.status}
                    disabled={!canEdit || update.isPending}
                    onChange={(event) => update.mutate({ id: gateway.id, status: event.target.value as OlcrtcGatewayStatus })}
                    aria-label={`Set ${gateway.name} gateway status`}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {GATEWAY_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </TableCell>
              </TableRow>
            ))}
            {overview.gateways.length === 0 ? <EmptyRow colSpan={5} label="No gateways have checked in" /> : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RoomsCard({ overview, canEdit }: { readonly overview: OlcrtcOverview; readonly canEdit: boolean }) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: ({ id, status, leaseSessionId }: { readonly id: string; readonly status: OlcrtcRoomStatus; readonly leaseSessionId: string | null }) =>
      olcrtcApi.updateRoom(id, { status, leaseSessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Room updated')
    },
    onError: () => toast.error('Room update failed'),
  })

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Rooms</CardTitle><CardDescription>Recent provider rooms and their current lease state.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Room</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Lease</TableHead><TableHead>Expires</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {overview.rooms.map((room) => (
              <TableRow key={room.id}>
                <TableCell className="max-w-[280px] truncate font-mono text-xs">{room.externalUrl ?? room.externalRoomId}</TableCell>
                <TableCell>{room.provider}</TableCell>
                <TableCell><StatusBadge status={room.status} /></TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{room.leaseSessionId ?? 'free'}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(room.expiresAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit || update.isPending || room.leaseSessionId === null || isTerminalRoomStatus(room.status)}
                      onClick={() => update.mutate({ id: room.id, status: 'READY', leaseSessionId: null })}
                    >
                      Release
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!canEdit || update.isPending || isTerminalRoomStatus(room.status)}
                      onClick={() => update.mutate({ id: room.id, status: 'INVALID', leaseSessionId: null })}
                    >
                      Invalidate
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {overview.rooms.length === 0 ? <EmptyRow colSpan={6} label="No rooms yet" /> : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SessionsCard({ overview, canEdit }: { readonly overview: OlcrtcOverview; readonly canEdit: boolean }) {
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: ({ id, status, lastError }: { readonly id: string; readonly status: OlcrtcSessionStatus; readonly lastError: string }) => olcrtcApi.updateSession(id, { status, lastError }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Session updated')
    },
    onError: () => toast.error('Session update failed'),
  })

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Recent sessions</CardTitle><CardDescription>Latest user allocations without crypto keys.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Provider</TableHead><TableHead>Status</TableHead><TableHead>Gateway</TableHead><TableHead>Expires</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {overview.sessions.map((session) => (
              <TableRow key={session.id}>
                <TableCell className="font-mono text-xs">{session.userId}</TableCell>
                <TableCell>{session.provider}</TableCell>
                <TableCell><StatusBadge status={session.status} /></TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{session.gatewayId ?? 'pending'}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(session.expiresAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canEdit || update.isPending || isTerminalSessionStatus(session.status)}
                      onClick={() => update.mutate({ id: session.id, status: 'STOPPED', lastError: 'operator stopped session' })}
                    >
                      Stop
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!canEdit || update.isPending || isTerminalSessionStatus(session.status)}
                      onClick={() => update.mutate({ id: session.id, status: 'FAILED', lastError: 'operator marked session failed' })}
                    >
                      Fail
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {overview.sessions.length === 0 ? <EmptyRow colSpan={6} label="No sessions yet" /> : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function CreateProviderAccountCard({ canCreate }: { readonly canCreate: boolean }) {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<OlcrtcProvider>('JITSI')
  const [name, setName] = useState('')
  const [credentialHint, setCredentialHint] = useState('')
  const [credentialsJson, setCredentialsJson] = useState('{}')
  const [isEnabled, setIsEnabled] = useState(true)

  const create = useMutation({
    mutationFn: olcrtcApi.createProviderAccount,
    onSuccess: () => {
      setName('')
      setCredentialHint('')
      setCredentialsJson('{}')
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Provider account created')
    },
    onError: (error: unknown) => {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(message ?? 'Provider account creation failed')
    },
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    let credentials: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(credentialsJson)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) credentials = parsed as Record<string, unknown>
      else throw new Error('Credentials must be a JSON object')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Credentials must be valid JSON')
      return
    }
    create.mutate({
      provider,
      name: name.trim(),
      credentials,
      credentialHint: credentialHint.trim() === '' ? undefined : credentialHint.trim(),
      isEnabled,
    })
  }

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4" aria-hidden /> Add provider account</CardTitle>
        <CardDescription>Credentials are encrypted server-side and are not readable after save.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-provider">Provider</Label>
            <select
              id="olcrtc-provider"
              value={provider}
              disabled={!canCreate || create.isPending}
              onChange={(event) => setProvider(event.target.value as OlcrtcProvider)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-provider-name">Name</Label>
            <Input id="olcrtc-provider-name" value={name} disabled={!canCreate || create.isPending} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-provider-hint">Credential hint</Label>
            <Input id="olcrtc-provider-hint" value={credentialHint} disabled={!canCreate || create.isPending} onChange={(event) => setCredentialHint(event.target.value)} placeholder="Session_id: abc..." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-provider-credentials">Credentials JSON</Label>
            <Textarea id="olcrtc-provider-credentials" value={credentialsJson} disabled={!canCreate || create.isPending} onChange={(event) => setCredentialsJson(event.target.value)} rows={6} spellCheck={false} className="font-mono text-xs" />
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <Label htmlFor="olcrtc-provider-enabled">Enabled</Label>
            <Switch id="olcrtc-provider-enabled" checked={isEnabled} disabled={!canCreate || create.isPending} onCheckedChange={setIsEnabled} />
          </div>
          <Button type="submit" className="w-full" disabled={!canCreate || create.isPending || name.trim() === ''}>
            {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            Save account
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ProviderAccountEditForm({ account, onCancel, onSaved }: { readonly account: OlcrtcProviderAccount; readonly onCancel: () => void; readonly onSaved: () => void }) {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<OlcrtcProvider>(account.provider)
  const [name, setName] = useState(account.name)
  const [credentialHint, setCredentialHint] = useState(account.credentialHint ?? '')
  const [credentialsJson, setCredentialsJson] = useState('')
  const [metadataJson, setMetadataJson] = useState(formatJsonObject(account.metadata))
  const [isEnabled, setIsEnabled] = useState(account.isEnabled)

  const update = useMutation({
    mutationFn: () => {
      const metadata = parseJsonObject(metadataJson, 'Metadata')
      const credentials = credentialsJson.trim() === '' ? undefined : parseJsonObject(credentialsJson, 'Credentials')
      return olcrtcApi.updateProviderAccount(account.id, {
        provider,
        name: name.trim(),
        credentialHint: credentialHint.trim() === '' ? null : credentialHint.trim(),
        credentials,
        isEnabled,
        metadata,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success('Provider account updated')
      onSaved()
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : 'Provider account update failed'),
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    update.mutate()
  }

  return (
    <form className="mt-4 space-y-4 rounded-lg border p-4" onSubmit={handleSubmit}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Edit provider account</h3>
          <p className="text-sm text-muted-foreground">Leave credentials blank to keep the stored encrypted value.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`olcrtc-edit-provider-${account.id}`}>Provider</Label>
          <select id={`olcrtc-edit-provider-${account.id}`} value={provider} disabled={update.isPending} onChange={(event) => setProvider(event.target.value as OlcrtcProvider)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
            {PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`olcrtc-edit-provider-name-${account.id}`}>Name</Label>
          <Input id={`olcrtc-edit-provider-name-${account.id}`} value={name} disabled={update.isPending} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`olcrtc-edit-provider-hint-${account.id}`}>Credential hint</Label>
          <Input id={`olcrtc-edit-provider-hint-${account.id}`} value={credentialHint} disabled={update.isPending} onChange={(event) => setCredentialHint(event.target.value)} />
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <Label htmlFor={`olcrtc-edit-provider-enabled-${account.id}`}>Enabled</Label>
          <Switch id={`olcrtc-edit-provider-enabled-${account.id}`} checked={isEnabled} disabled={update.isPending} onCheckedChange={setIsEnabled} />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`olcrtc-edit-provider-credentials-${account.id}`}>Rotate credentials JSON</Label>
          <Textarea id={`olcrtc-edit-provider-credentials-${account.id}`} value={credentialsJson} disabled={update.isPending} onChange={(event) => setCredentialsJson(event.target.value)} rows={5} spellCheck={false} className="font-mono text-xs" placeholder="Leave empty to keep current credentials" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`olcrtc-edit-provider-metadata-${account.id}`}>Metadata JSON</Label>
          <Textarea id={`olcrtc-edit-provider-metadata-${account.id}`} value={metadataJson} disabled={update.isPending} onChange={(event) => setMetadataJson(event.target.value)} rows={5} spellCheck={false} className="font-mono text-xs" />
        </div>
      </div>
      <Button type="submit" disabled={update.isPending || name.trim() === ''}>
        {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
        Save changes
      </Button>
    </form>
  )
}

function CreateProfileCard({ overview, canCreate }: { readonly overview: OlcrtcOverview; readonly canCreate: boolean }) {
  return <ProfileForm title="Add profile" description="Create an enabled provisioning profile ordered by priority." overview={overview} canSubmit={canCreate} />
}

function ProfileEditForm({ profile, overview, onCancel, onSaved }: { readonly profile: OlcrtcProfile; readonly overview: OlcrtcOverview; readonly onCancel: () => void; readonly onSaved: () => void }) {
  return (
    <div className="mt-4 rounded-lg border p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Edit profile</h3>
          <p className="text-sm text-muted-foreground">Changes affect new provisioning decisions only.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      <ProfileForm overview={overview} canSubmit initialProfile={profile} onSaved={onSaved} />
    </div>
  )
}

function ProfileForm({ title, description, overview, canSubmit, initialProfile, onSaved }: { readonly title?: string; readonly description?: string; readonly overview: OlcrtcOverview; readonly canSubmit: boolean; readonly initialProfile?: OlcrtcProfile; readonly onSaved?: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(initialProfile?.name ?? '')
  const [provider, setProvider] = useState<OlcrtcProvider>(initialProfile?.provider ?? 'JITSI')
  const [transport, setTransport] = useState<OlcrtcTransport>(initialProfile?.transport ?? 'DATACHANNEL')
  const [providerAccountId, setProviderAccountId] = useState(initialProfile?.providerAccountId ?? 'none')
  const [roomTemplate, setRoomTemplate] = useState(initialProfile?.roomTemplate ?? '')
  const [transportOptionsJson, setTransportOptionsJson] = useState(formatJsonObject(initialProfile?.transportOptions))
  const [metadataJson, setMetadataJson] = useState(formatJsonObject(initialProfile?.metadata))
  const [priority, setPriority] = useState(String(initialProfile?.priority ?? 100))
  const [isEnabled, setIsEnabled] = useState(initialProfile?.isEnabled ?? true)
  const isEdit = initialProfile !== undefined

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        provider,
        transport,
        providerAccountId: providerAccountId === 'none' ? null : providerAccountId,
        roomTemplate: roomTemplate.trim() === '' ? null : roomTemplate.trim(),
        transportOptions: parseJsonObject(transportOptionsJson, 'Transport options'),
        priority: Number(priority),
        isEnabled,
        metadata: parseJsonObject(metadataJson, 'Metadata'),
      }
      return isEdit ? olcrtcApi.updateProfile(initialProfile.id, payload) : olcrtcApi.createProfile(payload)
    },
    onSuccess: () => {
      if (!isEdit) {
        setName('')
        setRoomTemplate('')
        setTransportOptionsJson('{}')
        setMetadataJson('{}')
        setPriority('100')
      }
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY })
      toast.success(isEdit ? 'Profile updated' : 'Profile created')
      onSaved?.()
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : 'Profile save failed'),
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!Number.isInteger(Number(priority)) || Number(priority) < 0 || Number(priority) > 10_000) {
      toast.error('Priority must be an integer from 0 to 10000')
      return
    }
    save.mutate()
  }

  return (
    <Card className={title ? 'h-fit' : 'border-0 shadow-none' }>
      {title ? <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4" aria-hidden /> {title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader> : null}
      <CardContent className={title ? undefined : 'p-0'}>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
            <div className="space-y-1.5">
              <Label htmlFor={`olcrtc-profile-name-${initialProfile?.id ?? 'new'}`}>Name</Label>
              <Input id={`olcrtc-profile-name-${initialProfile?.id ?? 'new'}`} value={name} disabled={!canSubmit || save.isPending} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`olcrtc-profile-provider-${initialProfile?.id ?? 'new'}`}>Provider</Label>
              <select id={`olcrtc-profile-provider-${initialProfile?.id ?? 'new'}`} value={provider} disabled={!canSubmit || save.isPending} onChange={(event) => setProvider(event.target.value as OlcrtcProvider)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                {PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`olcrtc-profile-transport-${initialProfile?.id ?? 'new'}`}>Transport</Label>
              <select id={`olcrtc-profile-transport-${initialProfile?.id ?? 'new'}`} value={transport} disabled={!canSubmit || save.isPending} onChange={(event) => setTransport(event.target.value as OlcrtcTransport)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                {TRANSPORTS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`olcrtc-profile-account-${initialProfile?.id ?? 'new'}`}>Provider account</Label>
              <select id={`olcrtc-profile-account-${initialProfile?.id ?? 'new'}`} value={providerAccountId} disabled={!canSubmit || save.isPending} onChange={(event) => setProviderAccountId(event.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                <option value="none">None</option>
                {overview.providerAccounts.filter((account) => account.provider === provider).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`olcrtc-profile-priority-${initialProfile?.id ?? 'new'}`}>Priority</Label>
              <Input id={`olcrtc-profile-priority-${initialProfile?.id ?? 'new'}`} type="number" min={0} max={10000} step={1} value={priority} disabled={!canSubmit || save.isPending} onChange={(event) => setPriority(event.target.value)} required />
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <Label htmlFor={`olcrtc-profile-enabled-${initialProfile?.id ?? 'new'}`}>Enabled</Label>
              <Switch id={`olcrtc-profile-enabled-${initialProfile?.id ?? 'new'}`} checked={isEnabled} disabled={!canSubmit || save.isPending} onCheckedChange={setIsEnabled} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`olcrtc-profile-room-${initialProfile?.id ?? 'new'}`}>Room template</Label>
            <Input id={`olcrtc-profile-room-${initialProfile?.id ?? 'new'}`} value={roomTemplate} disabled={!canSubmit || save.isPending} onChange={(event) => setRoomTemplate(event.target.value)} placeholder="Optional provider room template" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`olcrtc-profile-options-${initialProfile?.id ?? 'new'}`}>Transport options JSON</Label>
            <Textarea id={`olcrtc-profile-options-${initialProfile?.id ?? 'new'}`} value={transportOptionsJson} disabled={!canSubmit || save.isPending} onChange={(event) => setTransportOptionsJson(event.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`olcrtc-profile-metadata-${initialProfile?.id ?? 'new'}`}>Metadata JSON</Label>
            <Textarea id={`olcrtc-profile-metadata-${initialProfile?.id ?? 'new'}`} value={metadataJson} disabled={!canSubmit || save.isPending} onChange={(event) => setMetadataJson(event.target.value)} rows={4} spellCheck={false} className="font-mono text-xs" />
          </div>
          <Button type="submit" className="w-full" disabled={!canSubmit || save.isPending || name.trim() === ''}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {isEdit ? 'Save profile' : 'Create profile'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function TrafficLedgerCard({
  items,
  sessionId,
  take,
  isRefreshing,
  onSessionIdChange,
  onTakeChange,
  onRefresh,
  onReset,
}: {
  readonly items: readonly { readonly id: string; readonly sessionId: string; readonly rxBytes: string; readonly txBytes: string; readonly source: string; readonly observedAt: string; readonly idempotencyKey: string | null }[]
  readonly sessionId: string
  readonly take: string
  readonly isRefreshing: boolean
  readonly onSessionIdChange: (value: string) => void
  readonly onTakeChange: (value: string) => void
  readonly onRefresh: () => void
  readonly onReset: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Traffic ledger</CardTitle>
        <CardDescription>Latest agent traffic reports. Values are cumulative bytes reported by the gateway.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_auto_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-traffic-session">Session ID</Label>
            <Input
              id="olcrtc-traffic-session"
              value={sessionId}
              onChange={(event) => onSessionIdChange(event.target.value)}
              placeholder="Filter by exact session ID"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="olcrtc-traffic-take">Rows</Label>
            <Input
              id="olcrtc-traffic-take"
              type="number"
              min={1}
              max={500}
              step={1}
              value={take}
              onChange={(event) => onTakeChange(event.target.value)}
            />
          </div>
          <Button type="button" variant="outline" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="mr-2 h-4 w-4" aria-hidden />}
            Refresh
          </Button>
          <Button type="button" variant="ghost" onClick={onReset} disabled={sessionId === '' && take === '25'}>Reset</Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Session</TableHead><TableHead>Source</TableHead><TableHead>RX</TableHead><TableHead>TX</TableHead><TableHead>Observed</TableHead><TableHead>Idempotency</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">{item.sessionId}</TableCell>
                <TableCell>{item.source}</TableCell>
                <TableCell>{formatBytes(item.rxBytes)}</TableCell>
                <TableCell>{formatBytes(item.txBytes)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(item.observedAt)}</TableCell>
                <TableCell className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">{item.idempotencyKey ?? 'none'}</TableCell>
              </TableRow>
            ))}
            {items.length === 0 ? <EmptyRow colSpan={6} label="No traffic reports yet" /> : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { readonly status: string }) {
  const normalized = status.toUpperCase()
  const variant = normalized.includes('FAILED') || normalized.includes('UNHEALTHY') || normalized.includes('INVALID')
    ? 'destructive'
    : normalized.includes('ACTIVE') || normalized.includes('ENABLED') || normalized.includes('IN_USE')
      ? 'success'
      : normalized.includes('PENDING') || normalized.includes('STARTING') || normalized.includes('DRAINING')
        ? 'warning'
        : 'outline'
  return <Badge variant={variant}>{status}</Badge>
}

function EmptyRow({ colSpan, label }: { readonly colSpan: number; readonly label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">{label}</TableCell>
    </TableRow>
  )
}

function isTerminalSessionStatus(status: OlcrtcSessionStatus): boolean {
  return status === 'STOPPED' || status === 'FAILED' || status === 'EXPIRED'
}

function isTerminalRoomStatus(status: OlcrtcRoomStatus): boolean {
  return status === 'INVALID' || status === 'DELETED' || status === 'EXPIRED'
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'never'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function formatBytes(value: string): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return value
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const
  let current = bytes / 1024
  for (const unit of units) {
    if (current < 1024) return `${current.toFixed(current >= 10 ? 1 : 2)} ${unit}`
    current /= 1024
  }
  return `${current.toFixed(1)} PiB`
}

function normalizeTrafficTake(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return 25
  return Math.min(500, Math.max(1, parsed))
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value.trim() === '' ? '{}' : value)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error(`${label} must be a JSON object`)
}

function formatJsonObject(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value, null, 2)
  return '{}'
}
