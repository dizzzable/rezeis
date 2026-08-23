import { useState, type JSX } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Shield,
  ShieldCheck,
  Copy,
  AlertTriangle,
  Fingerprint,
  KeyRound,
  Cpu,
  CloudCog,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { authStorage } from '@/lib/auth-storage'
import { expectArray } from '@/lib/api-utils'
import { getErrorMessage } from '@/lib/http-errors'

import {
  getTwoFactorStatus,
  enrollTwoFactor,
  confirmTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
  readLegacyRecoveryCount,
  LEGACY_COUNT_UNREPORTED,
  type LegacyRecoveryCount,
  type TwoFactorEnrollment,
  type TwoFactorStatus,
} from './two-factor-api'

/**
 * Security tab — single page for the current admin to manage:
 *   • TOTP 2FA (enable / confirm / disable / recovery codes)
 *   • Password change
 *   • Passkeys (WebAuthn) — list / register / rename / delete
 *
 * Layout (≥lg):
 *   row 1: [ 2FA              ][ Change password ]
 *   row 2: [ Passkey                              ]
 *
 * 2FA and password are intentionally placed side-by-side with equal heights.
 */
export default function TwoFactorPage(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: status, isLoading } = useQuery({
    queryKey: ['admin-2fa-status'],
    queryFn: getTwoFactorStatus,
    staleTime: 10_000,
  })

  const [pending, setPending] = useState<TwoFactorEnrollment | null>(null)
  const [confirmCode, setConfirmCode] = useState('')
  /**
   * The current password, once the server has asked for it. Held here rather
   * than assumed, so an operator whose account does not need it is never
   * prompted: the first attempt goes without, and only a `factor`-carrying 401
   * turns the field on.
   */
  const [enrollPassword, setEnrollPassword] = useState('')
  const [enrollNeedsPassword, setEnrollNeedsPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const enrollMutation = useMutation({
    mutationFn: enrollTwoFactor,
    onSuccess: (data) => {
      setPending(data)
      setError(null)
      setEnrollPassword('')
      setEnrollNeedsPassword(false)
      setInfo(t('twoFactorPage.info.scanQr'))
    },
    onError: (err) => {
      // Not a failure the operator caused — it is the prompt. Minting a second
      // factor demands the current password, and this 401 is how the server
      // says so. Without reading `code`/`factor` off the wire the panel would
      // show "failed to start enrollment" and 2FA could never be switched on.
      if (readDemandedFactor(err, 'totp_enroll_reauth_required') === 'password') {
        setEnrollNeedsPassword(true)
        setError(null)
        setInfo(t('twoFactorPage.info.enrollPassword'))
        return
      }
      setEnrollPassword('')
      setError(getErrorMessage(err, t('twoFactorPage.errors.enrollFailed')))
    },
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
    onError: (err) => setError(getErrorMessage(err, t('twoFactorPage.errors.invalidCode'))),
  })

  const disableMutation = useMutation({
    mutationFn: disableTwoFactor,
    onSuccess: () => {
      setError(null)
      setInfo(t('twoFactorPage.info.disabled'))
      queryClient.invalidateQueries({ queryKey: ['admin-2fa-status'] })
    },
    onError: (err) => setError(getErrorMessage(err, t('twoFactorPage.errors.invalidCode'))),
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
    onError: (err) => setError(getErrorMessage(err, t('twoFactorPage.errors.invalidCode'))),
  })

  if (isLoading || !status) {
    return <Skeleton className="h-72 w-full max-w-2xl" />
  }

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

      {pending ? (
        <EnrollmentPendingCard
          enrollment={pending}
          confirmCode={confirmCode}
          onCodeChange={setConfirmCode}
          onConfirm={(code) => confirmMutation.mutate({ code })}
          confirmPending={confirmMutation.isPending}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 items-stretch">
          <TwoFactorStatusCard
            status={status}
            onEnable={() =>
              enrollMutation.mutate(
                enrollNeedsPassword ? { password: enrollPassword } : undefined,
              )
            }
            enrollPending={enrollMutation.isPending}
            enrollNeedsPassword={enrollNeedsPassword}
            enrollPassword={enrollPassword}
            onEnrollPasswordChange={setEnrollPassword}
            onDisable={(code) => disableMutation.mutate({ code })}
            onRegenerate={(code) => regenerateMutation.mutate({ code })}
            disablePending={disableMutation.isPending}
            regeneratePending={regenerateMutation.isPending}
          />
          <ChangePasswordSection />
        </div>
      )}

      <PasskeySection />

    </div>
  )
}

// ── 2FA status card (left column on desktop) ─────────────────────────────────

function TwoFactorStatusCard({
  status,
  onEnable,
  enrollNeedsPassword,
  enrollPassword,
  onEnrollPasswordChange,
  enrollPending,
  onDisable,
  onRegenerate,
  disablePending,
  regeneratePending,
}: {
  readonly status: TwoFactorStatus
  readonly onEnable: () => void
  readonly enrollNeedsPassword: boolean
  readonly enrollPassword: string
  readonly onEnrollPasswordChange: (value: string) => void
  readonly enrollPending: boolean
  readonly onDisable: (code: string) => void
  readonly onRegenerate: (code: string) => void
  readonly disablePending: boolean
  readonly regeneratePending: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className="flex h-full flex-col">
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
      <CardContent className="flex-1 space-y-3">
        {status.enabled ? (
          <EnabledControls
            legacy={readLegacyRecoveryCount(status)}
            onDisable={onDisable}
            onRegenerate={onRegenerate}
            disablePending={disablePending}
            regeneratePending={regeneratePending}
          />
        ) : (
          <div className="space-y-3">
            {/*
              Shown only once the server has asked for it. Minting a second
              factor demands the current password, and the first attempt goes
              without one precisely so an operator is never prompted for a
              credential their account does not need.
            */}
            {enrollNeedsPassword ? (
              <div className="grid gap-2">
                <Label htmlFor="enroll-reauth-pw">
                  {t('twoFactorPage.passkey.reauth.passwordLabel')}
                </Label>
                <Input
                  id="enroll-reauth-pw"
                  type="password"
                  autoComplete="current-password"
                  value={enrollPassword}
                  onChange={(e) => onEnrollPasswordChange(e.target.value)}
                />
              </div>
            ) : null}
            <Button
              onClick={onEnable}
              disabled={
                enrollPending || (enrollNeedsPassword && enrollPassword.trim().length === 0)
              }
            >
              {enrollPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('twoFactorPage.enableButton')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Enrollment pending card (full-width while user scans QR) ─────────────────

function EnrollmentPendingCard({
  enrollment,
  confirmCode,
  onCodeChange,
  onConfirm,
  confirmPending,
}: {
  readonly enrollment: TwoFactorEnrollment
  readonly confirmCode: string
  readonly onCodeChange: (code: string) => void
  readonly onConfirm: (code: string) => void
  readonly confirmPending: boolean
}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('twoFactorPage.confirm.title')}</CardTitle>
        <CardDescription>{t('twoFactorPage.confirm.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrollment.otpauthUri && (
          <>
            <div className="flex flex-col items-center gap-3">
              <img
                alt={t('twoFactorPage.confirm.qrAlt')}
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
                onChange={(e) => onCodeChange(e.target.value)}
              />
            </div>
            <Button
              onClick={() => onConfirm(confirmCode.trim())}
              disabled={confirmPending || confirmCode.trim().length !== 6}
              className="w-full"
            >
              {confirmPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('twoFactorPage.confirm.confirmButton')}
            </Button>
          </>
        )}
        {enrollment.recoveryCodes.length > 0 && <RecoveryCodesPanel codes={enrollment.recoveryCodes} />}
      </CardContent>
    </Card>
  )
}

// ── Change Password ──────────────────────────────────────────────────────────

function ChangePasswordSection(): JSX.Element {
  const { t } = useTranslation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await api.post('/admin/auth/password', {
        currentPassword,
        newPassword,
      })
      return res.data
    },
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success(t('twoFactorPage.password.success'))
    },
    onError: (err) => {
      toast.error(getErrorMessage(err, t('twoFactorPage.password.failed')))
    },
  })

  const canSubmit =
    currentPassword.length >= 1 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    !mutation.isPending

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          {t('twoFactorPage.password.title')}
        </CardTitle>
        <CardDescription>{t('twoFactorPage.password.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
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

/**
 * The recovery codes an operator is still holding that predate the salted,
 * 80-bit format.
 *
 * Those codes were deliberately NOT invalidated. A recovery code is
 * single-use, so the verify-then-upgrade trick is structurally impossible —
 * the entry that verifies is the entry that gets deleted — and hard
 * invalidation would lock out exactly the operator who has lost their
 * authenticator and is holding a printed code, which is the situation these
 * codes exist for. The consequence is that nothing repairs it except
 * regenerating, which is why this renders INSIDE the regenerate control rather
 * than on some security page nobody opens.
 *
 * Three states, and the third is why `readLegacyRecoveryCount()` exists:
 *
 *   n > 0        — n of the remaining codes are the weak kind. Not "n codes
 *                  left": the card header above already says how many codes
 *                  remain in total, and these are a SUBSET of that number.
 *   0            — every remaining code is current. Renders nothing.
 *   'unreported' — the server never sent the field. A backend older than the
 *                  change cannot answer, and rendering that as 0 would tell an
 *                  operator their codes are fine on no evidence at all.
 */
function LegacyRecoveryCodesNotice({
  legacy,
}: {
  readonly legacy: LegacyRecoveryCount
}): JSX.Element | null {
  const { t } = useTranslation()
  if (legacy !== LEGACY_COUNT_UNREPORTED && legacy <= 0) return null
  return (
    <div
      data-testid="legacy-recovery-notice"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/30"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="space-y-1">
          <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
            {t('twoFactorPage.legacy.title')}
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {legacy === LEGACY_COUNT_UNREPORTED
              ? t('twoFactorPage.legacy.unknown')
              : t('twoFactorPage.legacy.some', { count: legacy })}
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {t('twoFactorPage.legacy.action')}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── 2FA enabled controls ─────────────────────────────────────────────────────

function EnabledControls(props: {
  readonly legacy: LegacyRecoveryCount
  readonly onDisable: (code: string) => void
  readonly onRegenerate: (code: string) => void
  readonly disablePending: boolean
  readonly regeneratePending: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [disableCode, setDisableCode] = useState('')
  const [regenerateCode, setRegenerateCode] = useState('')

  return (
    <div className="space-y-6">
      <div className="space-y-2" data-testid="regenerate-recovery-codes">
        <LegacyRecoveryCodesNotice legacy={props.legacy} />
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

function RecoveryCodesPanel({ codes }: { readonly codes: readonly string[] }): JSX.Element {
  const { t } = useTranslation()
  const copy = (): void => {
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

// ── Passkey Management ──────────────────────────────────────────────────────

interface PasskeyCredential {
  readonly id: string
  readonly name: string
  readonly credentialId: string
  readonly transports: readonly string[]
  readonly backedUp: boolean
  readonly registeredAt: string
  readonly lastUsedAt: string | null
}

/** The two credentials the enrolment gate can demand. */
type PasskeyReauthFactor = 'totp' | 'password'

/**
 * The enrolment gate's refusal, read off the wire rather than off the local
 * guess below.
 *
 * The server picks the factor from the ACCOUNT — a code when 2FA is on, the
 * password when it is not — specifically so a hijacked session cannot nominate
 * the weaker one. The client mirrors that choice from its cached 2FA status,
 * and this 401 is what arrives when the two disagree: a stale cache asks for a
 * password, the account wants its code, and the request lands with an empty
 * `code` field. Without reading `factor` back, the dialog re-renders the same
 * wrong field and the operator can never satisfy it.
 */
function readDemandedFactor(
  error: unknown,
  expectedCode = 'passkey_reauth_required',
): PasskeyReauthFactor | null {
  const body = (error as { response?: { data?: unknown } } | null)?.response?.data
  if (typeof body !== 'object' || body === null) return null
  const { code, factor } = body as { code?: unknown; factor?: unknown }
  if (code !== expectedCode) return null
  return factor === 'totp' || factor === 'password' ? factor : null
}

function PasskeySection(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false)
  const [pendingName, setPendingName] = useState('')
  /** The fresh factor the enrolment gate demands: a code, or a password. */
  const [reauthValue, setReauthValue] = useState('')
  /** Set once the server has told us which factor it actually wants. */
  const [demandedFactor, setDemandedFactor] = useState<PasskeyReauthFactor | null>(null)

  // Which factor to ask for follows the account's own 2FA state, exactly as
  // the server decides it. Shares the cache key with the card above, so this
  // costs no extra request.
  const { data: twoFactorStatus } = useQuery({
    queryKey: ['admin-2fa-status'],
    queryFn: getTwoFactorStatus,
    staleTime: 10_000,
  })
  // The server's answer wins over the local guess whenever we have one: the
  // guess is a cache, and this dialog is reachable while that cache is stale.
  const reauthWithCode =
    demandedFactor !== null ? demandedFactor === 'totp' : twoFactorStatus?.enabled === true

  const { data: passkeys, isLoading } = useQuery({
    queryKey: ['admin-passkeys'],
    queryFn: async () => {
      const res = await api.get('/admin/passkey/credentials')
      return expectArray<PasskeyCredential>(res.data)
    },
    staleTime: 30_000,
  })

  const registerMutation = useMutation({
    mutationFn: async (name: string) => {
      // Enrolling a passkey now demands a fresh factor, because a passkey is a
      // credential that outlives a password change: without this, one stolen
      // session bought permanent, password-and-TOTP-free re-entry. Which factor
      // is required is decided by the SERVER from the account — a TOTP or
      // recovery code when 2FA is on, the current password when it is not — so
      // the prompt below only mirrors that, and sending the wrong one fails
      // closed rather than downgrading.
      const reauth = reauthWithCode
        ? { code: reauthValue.trim() }
        : { password: reauthValue };
      // Get registration options. `submitsCredential` is the rule stated where
      // the knowledge is — this request carries a password or a code, so its
      // 401 is the verdict on THAT, and must not tear down the session. The
      // path also sits in `lib/api.ts`'s compatibility list; saying it here as
      // well keeps the exemption attached to the request if the URL ever moves.
      const optionsRes = await api.post('/admin/passkey/register/options', reauth, {
        submitsCredential: true,
      })
      const options = optionsRes.data as {
        challenge: string
        rp: { name: string; id: string }
        user: { id: string; name: string; displayName: string }
        pubKeyCredParams: { type: 'public-key'; alg: number }[]
        timeout?: number
        attestation?: AttestationConveyancePreference
        authenticatorSelection?: AuthenticatorSelectionCriteria
        excludeCredentials?: { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }[]
      }

      // WebAuthn requires base64url-encoded challenge/user.id/credentialIds
      // converted to ArrayBuffers in the credential creation request.
      const publicKey: PublicKeyCredentialCreationOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rp: options.rp,
        user: {
          id: base64urlToBuffer(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation,
        authenticatorSelection: options.authenticatorSelection,
        excludeCredentials: options.excludeCredentials?.map((c) => ({
          id: base64urlToBuffer(c.id),
          type: 'public-key',
          transports: c.transports,
        })),
      }

      const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null
      if (!credential) throw new Error('Registration cancelled')

      const response = credential.response as AuthenticatorAttestationResponse

      await api.post(
        '/admin/passkey/register/verify',
        {
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
          name: name.trim() || `Passkey ${new Date().toLocaleDateString()}`,
        },
        // Carries the WebAuthn attestation, so its 401 is a verdict on that.
        { submitsCredential: true },
      )
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-passkeys'] })
      setRegisterDialogOpen(false)
      setPendingName('')
      // Never leave a code or a password sitting in component state after the
      // ceremony — and a one-time code is spent, so re-sending it would fail.
      setReauthValue('')
      setDemandedFactor(null)
      toast.success(t('twoFactorPage.passkey.toasts.registered'))
    },
    onError: (err: unknown) => {
      const demanded = readDemandedFactor(err)
      if (demanded !== null) {
        // Not a failure the operator caused — it is the prompt, arriving late
        // because we asked for the wrong credential. Re-point the field, drop
        // whatever was typed into the old one, and refresh the 2FA status that
        // was stale enough to mislead us so the next attempt starts correct.
        setDemandedFactor(demanded)
        setReauthValue('')
        queryClient.invalidateQueries({ queryKey: ['admin-2fa-status'] })
        setRegisterDialogOpen(true)
      }
      const e = err as { message?: string; response?: { data?: { message?: string } } }
      const msg = e?.message?.includes('cancelled')
        ? t('twoFactorPage.passkey.toasts.cancelled')
        : (e?.response?.data?.message ?? t('twoFactorPage.passkey.toasts.registerFailed'))
      toast.error(msg)
    },
  })

  const renameMutation = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await api.patch(`/admin/passkey/credentials/${id}`, { name })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-passkeys'] })
      toast.success(t('twoFactorPage.passkey.toasts.renamed'))
    },
    onError: () => toast.error(t('twoFactorPage.passkey.toasts.renameFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete(`/admin/passkey/credentials/${id}`)
      return (res.data ?? {}) as { accessToken?: string }
    },
    onSuccess: (data) => {
      // Removing a passkey bumps `tokenVersion`, which is the whole point —
      // otherwise a session minted by a compromised passkey outlived its
      // revocation by up to 24 hours. The bump invalidates THIS tab's token
      // too, so the server hands back a fresh one and we adopt it. Without
      // this the operator revokes a key and is signed out on their next click,
      // which reads as a bug and trains them not to revoke.
      if (typeof data.accessToken === 'string' && data.accessToken.length > 0) {
        authStorage.setToken(data.accessToken)
      }
      queryClient.invalidateQueries({ queryKey: ['admin-passkeys'] })
      toast.success(t('twoFactorPage.passkey.toasts.deleted'))
    },
    onError: () => toast.error(t('twoFactorPage.passkey.toasts.deleteFailed')),
  })

  const passkeySupported = typeof window !== 'undefined' && 'credentials' in navigator

  const openRegisterDialog = (): void => {
    setPendingName(t('twoFactorPage.passkey.defaultName', { date: new Date().toLocaleDateString() }))
    // A fresh attempt starts from the local status again rather than from the
    // last refusal: enabling or disabling 2FA invalidates that query, so by now
    // it is the newer of the two. If it is still wrong the server says so again.
    setDemandedFactor(null)
    setRegisterDialogOpen(true)
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5" />
            <div>
              <CardTitle>{t('twoFactorPage.passkey.title')}</CardTitle>
              <CardDescription>{t('twoFactorPage.passkey.description')}</CardDescription>
            </div>
          </div>
          {passkeySupported && (
            <Button
              variant="outline"
              size="sm"
              onClick={openRegisterDialog}
              disabled={registerMutation.isPending}
            >
              {registerMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {t('twoFactorPage.passkey.register')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {!passkeySupported ? (
            <p className="text-sm text-muted-foreground">{t('twoFactorPage.passkey.notSupported')}</p>
          ) : isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : passkeys && passkeys.length > 0 ? (
            <div className="space-y-2">
              {passkeys.map((pk) => (
                <PasskeyRow
                  key={pk.id}
                  passkey={pk}
                  onRename={(name) => renameMutation.mutate({ id: pk.id, name })}
                  onDelete={() => deleteMutation.mutate(pk.id)}
                  renamePending={renameMutation.isPending}
                  deletePending={deleteMutation.isPending}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('twoFactorPage.passkey.empty')}</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={registerDialogOpen} onOpenChange={setRegisterDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('twoFactorPage.passkey.registerDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('twoFactorPage.passkey.registerDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="passkey-name">{t('twoFactorPage.passkey.registerDialog.nameLabel')}</Label>
            <Input
              id="passkey-name"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              placeholder={t('twoFactorPage.passkey.registerDialog.namePlaceholder')}
              maxLength={30}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('twoFactorPage.passkey.registerDialog.nameHint')}
            </p>
          </div>
          {/* The fresh-factor prompt. Which one is asked for follows the
              account's own 2FA state, the same way the server decides it. */}
          <div className="space-y-2">
            <Label htmlFor="passkey-reauth">
              {reauthWithCode
                ? t('twoFactorPage.passkey.registerDialog.codeLabel')
                : t('twoFactorPage.passkey.registerDialog.passwordLabel')}
            </Label>
            <Input
              id="passkey-reauth"
              type={reauthWithCode ? 'text' : 'password'}
              value={reauthValue}
              onChange={(e) => setReauthValue(e.target.value)}
              autoComplete={reauthWithCode ? 'one-time-code' : 'current-password'}
              // Not `numeric`: a recovery code is hex, and this is exactly the
              // moment an operator without their authenticator needs a–f.
              inputMode="text"
              maxLength={reauthWithCode ? 20 : 128}
            />
            <p className="text-[11px] text-muted-foreground">
              {reauthWithCode
                ? t('twoFactorPage.passkey.registerDialog.codeHint')
                : t('twoFactorPage.passkey.registerDialog.passwordHint')}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRegisterDialogOpen(false)
                setReauthValue('')
                setDemandedFactor(null)
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => registerMutation.mutate(pendingName)}
              disabled={
                registerMutation.isPending ||
                pendingName.trim().length < 2 ||
                reauthValue.trim().length === 0
              }
            >
              {registerMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              {t('twoFactorPage.passkey.registerDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PasskeyRow({
  passkey,
  onRename,
  onDelete,
  renamePending,
  deletePending,
}: {
  readonly passkey: PasskeyCredential
  readonly onRename: (name: string) => void
  readonly onDelete: () => void
  readonly renamePending: boolean
  readonly deletePending: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(passkey.name)

  const isPlatform = passkey.transports.includes('internal')
  const TransportIcon = isPlatform ? Cpu : KeyRound

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border bg-background/40 px-3 py-2">
      <div className="flex flex-1 items-start gap-3">
        <TransportIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={30}
                className="h-7 text-sm"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onRename(draftName.trim())
                  setEditing(false)
                }}
                disabled={renamePending || draftName.trim().length < 2}
              >
                {t('common.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraftName(passkey.name)
                  setEditing(false)
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="text-left text-sm font-medium hover:underline"
              onClick={() => setEditing(true)}
              aria-label={t('twoFactorPage.passkey.renameAria', { name: passkey.name })}
            >
              {passkey.name}
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-muted-foreground">
            <span>{t('twoFactorPage.passkey.registered', { date: new Date(passkey.registeredAt).toLocaleDateString() })}</span>
            {passkey.lastUsedAt && (
              <span>· {t('twoFactorPage.passkey.lastUsed', { date: new Date(passkey.lastUsedAt).toLocaleDateString() })}</span>
            )}
            {passkey.backedUp && (
              <Badge variant="outline" className="h-4 gap-1 px-1 py-0 text-[10px]">
                <CloudCog className="h-3 w-3" />
                {t('twoFactorPage.passkey.synced')}
              </Badge>
            )}
            {isPlatform && (
              <Badge variant="outline" className="h-4 px-1 py-0 text-[10px]">
                {t('twoFactorPage.passkey.platform')}
              </Badge>
            )}
          </div>
        </div>
      </div>
      {!editing && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={deletePending}
          aria-label={t('twoFactorPage.passkey.deleteAria', { name: passkey.name })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

// ── WebAuthn helpers ────────────────────────────────────────────────────────

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + padding)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
