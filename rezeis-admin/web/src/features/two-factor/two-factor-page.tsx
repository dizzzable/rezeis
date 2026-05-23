/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: type API responses */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Shield, ShieldCheck, Copy, AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

import {
  getTwoFactorStatus,
  enrollTwoFactor,
  confirmTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  type TwoFactorEnrollment,
} from './two-factor-api'

/**
 * 2FA self-service for the current admin operator. The page has three
 * states:
 *   1. Disabled  --> Enable button starts an enrollment.
 *   2. Pending   --> show otpauth URI / secret + the recovery codes,
 *                    accept the first 6-digit code to finalize.
 *   3. Enabled   --> show status, button to disable, button to
 *                    regenerate recovery codes (each requires a code).
 *
 * The QR code is rendered server-side by an external image proxy
 * (`https://api.qrserver.com`) — saves shipping a QR library and the
 * URI itself contains no PII (just a Base32 secret + the bot's `issuer`
 * label).
 */
export default function TwoFactorPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: status, isLoading } = useQuery({
    queryKey: ['admin-2fa-status'],
    queryFn: getTwoFactorStatus,
    staleTime: 10_000,
  })

  const [pending, setPending] = useState<TwoFactorEnrollment | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const enrollMutation = useMutation({
    mutationFn: enrollTwoFactor,
    onSuccess: (data) => {
      setPending(data)
      setError(null)
      setInfo(t('twoFactorPage.info.scanQr'))
    },
    onError: (err: any) => setError(err.response?.data?.message ?? t('twoFactorPage.errors.enrollFailed')),
  })

  const confirmMutation = useMutation({
    mutationFn: confirmTwoFactor,
    onSuccess: () => {
      setPending(null)
      setConfirmCode('')
      setError(null)
      setInfo(t('twoFactorPage.info.enabled'))
      queryClient.invalidateQueries({ queryKey: ['admin-2fa-status'] })
    },
    onError: (err: any) => setError(err.response?.data?.message ?? t('twoFactorPage.errors.invalidCode')),
  })

  const disableMutation = useMutation({
    mutationFn: disableTwoFactor,
    onSuccess: () => {
      setError(null)
      setInfo(t('twoFactorPage.info.disabled'))
      queryClient.invalidateQueries({ queryKey: ['admin-2fa-status'] })
    },
    onError: (err: any) => setError(err.response?.data?.message ?? t('twoFactorPage.errors.invalidCode')),
  })

  const regenerateMutation = useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: (data) => {
      setError(null)
      setPending({
        secret: '',
        otpauthUri: '',
        recoveryCodes: data.recoveryCodes,
      })
      setInfo(t('twoFactorPage.info.newCodes'))
      queryClient.invalidateQueries({ queryKey: ['admin-2fa-status'] })
    },
    onError: (err: any) => setError(err.response?.data?.message ?? t('twoFactorPage.errors.invalidCode')),
  })

  if (isLoading || !status) {
    return <Skeleton className="h-72 w-full max-w-2xl" />
  }

  const renderEnrollmentPending = (enrollment: TwoFactorEnrollment) => (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t('twoFactorPage.confirm.title')}</CardTitle>
        <CardDescription>{t('twoFactorPage.confirm.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrollment.otpauthUri && (
          <>
            <div className="flex flex-col items-center gap-3">
              <img
                alt="2FA QR code"
                width={200}
                height={200}
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(enrollment.otpauthUri)}`}
                className="rounded border bg-background p-2"
              />
              <p className="text-xs text-muted-foreground">{t('twoFactorPage.confirm.secretManual')}</p>
              <code className="break-all rounded bg-muted px-3 py-1 text-sm">{enrollment.secret}</code>
            </div>
            <div className="space-y-2">
              <Label htmlFor="enroll-code">{t('twoFactorPage.confirm.codeLabel')}</Label>
              <Input
                id="enroll-code"
                inputMode="numeric"
                maxLength={6}
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
              />
            </div>
            <Button
              onClick={() => confirmMutation.mutate({ code: confirmCode.trim() })}
              disabled={confirmMutation.isPending || confirmCode.trim().length !== 6}
              className="w-full"
            >
              {confirmMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('twoFactorPage.confirm.confirmButton')}
            </Button>
          </>
        )}
        {enrollment.recoveryCodes.length > 0 && (
          <RecoveryCodesPanel codes={enrollment.recoveryCodes} />
        )}
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" />
          {t('twoFactorPage.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('twoFactorPage.subtitle')}
        </p>
      </div>

      {info && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200">
          {info}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {pending ? renderEnrollmentPending(pending) : (
        <Card className="max-w-2xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              {status.enabled ? (
                <ShieldCheck className="h-6 w-6 text-emerald-500" />
              ) : (
                <Shield className="h-6 w-6 text-muted-foreground" />
              )}
              <div>
                <CardTitle>{status.enabled ? t('twoFactorPage.enabled') : t('twoFactorPage.disabled')}</CardTitle>
                <CardDescription>
                  {status.enabled
                    ? t('twoFactorPage.recoveryCodesRemaining', { count: status.recoveryCodesRemaining })
                    : t('twoFactorPage.disabledDescription')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.enabled ? (
              <EnabledControls
                onDisable={(code) => disableMutation.mutate({ code })}
                onRegenerate={(code) => regenerateMutation.mutate({ code })}
                disablePending={disableMutation.isPending}
                regeneratePending={regenerateMutation.isPending}
              />
            ) : (
              <Button onClick={() => enrollMutation.mutate()} disabled={enrollMutation.isPending}>
                {enrollMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('twoFactorPage.enableButton')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Change Password + Passkey + Auth Providers */}
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <div className="space-y-6">
          <ChangePasswordSection />
        </div>
        <div className="space-y-6">
          <PasskeySection />
          <AuthProvidersInline />
        </div>
      </div>
    </div>
  )
}

// ── Change Password Section ──────────────────────────────────────────────────

function ChangePasswordSection() {
  const { t } = useTranslation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await (await import('@/lib/api')).api.post('/admin/auth/password', {
        currentPassword,
        newPassword,
      })
      return res.data
    },
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      // eslint-disable-next-line no-alert
      alert(t('twoFactorPage.password.success'))
    },
    onError: (err: any) => {
      // eslint-disable-next-line no-alert
      alert(err.response?.data?.message ?? t('twoFactorPage.password.failed'))
    },
  })

  const canSubmit =
    currentPassword.length >= 1 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !mutation.isPending

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          {t('twoFactorPage.password.title')}
        </CardTitle>
        <CardDescription>{t('twoFactorPage.password.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="current-pw">{t('twoFactorPage.password.current')}</Label>
          <Input
            id="current-pw"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-pw">{t('twoFactorPage.password.new')}</Label>
          <Input
            id="new-pw"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className="text-[11px] text-muted-foreground">{t('twoFactorPage.password.hint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-pw">{t('twoFactorPage.password.confirm')}</Label>
          <Input
            id="confirm-pw"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <p className="text-[11px] text-destructive">{t('twoFactorPage.password.mismatch')}</p>
          )}
        </div>
        <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
          {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('twoFactorPage.password.submit')}
        </Button>
      </CardContent>
    </Card>
  )
}

function EnabledControls(props: {
  onDisable: (code: string) => void
  onRegenerate: (code: string) => void
  disablePending: boolean
  regeneratePending: boolean
}) {
  const { t } = useTranslation()
  const [disableCode, setDisableCode] = useState('')
  const [regenerateCode, setRegenerateCode] = useState('')

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('twoFactorPage.controls.regenerateTitle')}</Label>
        <p className="text-xs text-muted-foreground">
          {t('twoFactorPage.controls.regenerateDescription')}
        </p>
        <div className="flex gap-2">
          <Input
            placeholder={t('twoFactorPage.controls.codePlaceholder')}
            value={regenerateCode}
            onChange={(e) => setRegenerateCode(e.target.value)}
            inputMode="numeric"
            maxLength={20}
          />
          <Button
            variant="outline"
            onClick={() => props.onRegenerate(regenerateCode.trim())}
            disabled={props.regeneratePending || regenerateCode.trim().length === 0}
          >
            {props.regeneratePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('twoFactorPage.controls.regenerateButton')}
          </Button>
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <Label className="text-sm font-medium text-destructive">{t('twoFactorPage.controls.disableTitle')}</Label>
        <p className="text-xs text-muted-foreground">
          {t('twoFactorPage.controls.disableDescription')}
        </p>
        <div className="flex gap-2">
          <Input
            placeholder={t('twoFactorPage.controls.codePlaceholder')}
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            inputMode="numeric"
            maxLength={20}
          />
          <Button
            variant="destructive"
            onClick={() => props.onDisable(disableCode.trim())}
            disabled={props.disablePending || disableCode.trim().length === 0}
          >
            {props.disablePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('twoFactorPage.controls.disableButton')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function RecoveryCodesPanel({ codes }: { codes: readonly string[] }) {
  const { t } = useTranslation()
  const copy = () => {
    navigator.clipboard?.writeText(codes.join('\n'))
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {t('twoFactorPage.recovery.title')}
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {t('twoFactorPage.recovery.description')}
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs">
            {codes.map((code) => (
              <code key={code} className="rounded bg-background px-2 py-1">
                {code}
              </code>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="mr-2 h-3 w-3" /> {t('twoFactorPage.recovery.copyAll')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Passkey Management Section ───────────────────────────────────────────────

function PasskeySection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: passkeys, isLoading } = useQuery({
    queryKey: ['admin-passkeys'],
    queryFn: async () => {
      const { api } = await import('@/lib/api')
      const res = await api.get<Array<{
        id: string
        name: string
        credentialId: string
        transports: string[]
        backedUp: boolean
        registeredAt: string
        lastUsedAt: string | null
      }>>('/admin/passkey/credentials')
      return res.data
    },
    staleTime: 30_000,
  })

  const registerMutation = useMutation({
    mutationFn: async () => {
      const { api } = await import('@/lib/api')
      // Get registration options
      const optionsRes = await api.post('/admin/passkey/register/options', {})
      const options = optionsRes.data

      // Call WebAuthn browser API
      const credential = await navigator.credentials.create({
        publicKey: options as unknown as PublicKeyCredentialCreationOptions,
      }) as PublicKeyCredential | null

      if (!credential) throw new Error('Registration cancelled')

      const response = credential.response as AuthenticatorAttestationResponse

      // Send to backend
      await api.post('/admin/passkey/register/verify', {
        response: {
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            attestationObject: bufferToBase64url(response.attestationObject),
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            transports: response.getTransports?.() ?? [],
          },
        },
        name: `Passkey ${new Date().toLocaleDateString()}`,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-passkeys'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { api } = await import('@/lib/api')
      await api.delete(`/admin/passkey/credentials/${id}`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-passkeys'] })
    },
  })

  const passkeySupported = typeof window !== 'undefined' && 'credentials' in navigator

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('twoFactorPage.passkey.title')}</CardTitle>
        <CardDescription>{t('twoFactorPage.passkey.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!passkeySupported ? (
          <p className="text-sm text-muted-foreground">{t('twoFactorPage.passkey.notSupported')}</p>
        ) : (
          <>
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : passkeys && passkeys.length > 0 ? (
              <div className="space-y-2">
                {passkeys.map((pk) => (
                  <div key={pk.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{pk.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('twoFactorPage.passkey.registered', { date: new Date(pk.registeredAt).toLocaleDateString() })}
                        {pk.lastUsedAt && ` · ${t('twoFactorPage.passkey.lastUsed', { date: new Date(pk.lastUsedAt).toLocaleDateString() })}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => deleteMutation.mutate(pk.id)}
                      disabled={deleteMutation.isPending}
                    >
                      {t('twoFactorPage.passkey.remove')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('twoFactorPage.passkey.empty')}</p>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => registerMutation.mutate()}
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {t('twoFactorPage.passkey.register')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ── Auth Providers Inline (inside Security tab) ──────────────────────────────

function AuthProvidersInline() {
  const { t } = useTranslation()
  const { data: providers, isLoading } = useQuery({
    queryKey: ['oauth', 'config'],
    queryFn: async () => {
      const { api } = await import('@/lib/api')
      const res = await api.get<Array<{ type: string; displayName: string; isEnabled: boolean }>>('/admin/oauth/config')
      return res.data
    },
    staleTime: 30_000,
  })

  const queryClient = useQueryClient()
  const toggleMutation = useMutation({
    mutationFn: async ({ type, enabled }: { type: string; enabled: boolean }) => {
      const { api } = await import('@/lib/api')
      await api.put(`/admin/oauth/config/${type}`, { isEnabled: enabled })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['oauth', 'config'] }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('twoFactorPage.authProviders.title')}</CardTitle>
        <CardDescription>{t('twoFactorPage.authProviders.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          providers?.map((p) => (
            <div key={p.type} className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-sm font-medium">{p.displayName}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${p.isEnabled ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                  {p.isEnabled ? t('twoFactorPage.authProviders.on') : t('twoFactorPage.authProviders.off')}
                </span>
                <button
                  type="button"
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${p.isEnabled ? 'bg-emerald-500' : 'bg-muted'}`}
                  onClick={() => toggleMutation.mutate({ type: p.type, enabled: !p.isEnabled })}
                  disabled={toggleMutation.isPending}
                  aria-label={`Toggle ${p.displayName}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${p.isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground pt-2">
          {t('twoFactorPage.authProviders.hint')}
        </p>
      </CardContent>
    </Card>
  )
}
