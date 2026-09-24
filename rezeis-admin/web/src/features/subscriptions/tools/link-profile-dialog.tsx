/**
 * «Привязать профиль» — this sheet's own dialog.
 * ─────────────────────────────────────────────
 * The fewest clicks that link one subscription to one Remnawave profile: a
 * numeric profile id (pre-filled when the check already found it), the
 * operator's word when nothing else proves the profile is this customer's, and
 * one press. It calls the user card's endpoint,
 * `PATCH /admin/users/subscriptions/:subscriptionId/remnawave-link`
 * `{ remnawaveId, confirmedWithoutProof }`, and the server stays the authority:
 * it reads the profile, refuses one another customer's `reiwa_id` line names
 * whatever is ticked, and records a link made on the operator's word as such.
 *
 * NOT the user card's dialog. That one lives inside a component another
 * surface owns and edits; sharing it would couple two screens' release
 * cadence to one component. The checkbox MEANS the same thing on both.
 *
 * NUMERIC ONLY. A 2.x UUID is exactly the kind of link these tabs exist to
 * replace, so the field refuses anything but digits before a request is made,
 * next to the field, instead of as a bare 400 toast.
 *
 * ONE ATTEMPT, ONE STATE. Everything the dialog holds — the id, the tick, the
 * chosen subscription, the last refusal — is reset when it OPENS, in the event
 * handler, never adjusted during render: the operator's word belongs to one
 * attempt and must not carry over to the next row.
 */
import { useId, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { adminQueryKeys } from '@/lib/admin-query-keys'
import { describeFailure } from './describe-failure'
import { isNumericRemnawaveId, linkRemnawaveProfile } from './panel-link-check-api'

/** A subscription the profile can be linked to, as the operator reads it. */
export interface LinkTarget {
  readonly subscriptionId: string
  readonly label: string
}

export function LinkProfileDialog({
  targets,
  initialProfileId,
}: {
  /** One subscription, or the customer's several subscriptions without a link. */
  readonly targets: readonly LinkTarget[]
  /** The profile id the check found, when it found one. */
  readonly initialProfileId: string | null
}): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [candidate, setCandidate] = useState('')
  const [confirmedWithoutProof, setConfirmedWithoutProof] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const onlyTarget = targets.length === 1 ? targets[0] : undefined

  const mutation = useMutation({
    mutationFn: linkRemnawaveProfile,
    onSuccess: () => {
      toast.success(t('subscriptionTools.linkDialog.linked'))
      setOpen(false)
      // The row leaves «Подписки без привязки», the profile leaves «Лишние
      // профили», and the customer's card and the subscriptions list change.
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.subscriptions.all })
      void queryClient.invalidateQueries({ queryKey: adminQueryKeys.users.all })
    },
    // The server's own sentence, next to the field: "belongs to another
    // customer", "nothing proves it", "already linked to another subscription"
    // each tell the operator what to do next, and a toast would be gone before
    // they read it.
    onError: (error: unknown) => setFailure(describeFailure(t, error)),
  })

  const changeOpen = (next: boolean): void => {
    if (next) {
      setCandidate(initialProfileId ?? '')
      setConfirmedWithoutProof(false)
      setChosen(onlyTarget?.subscriptionId ?? null)
      setFailure(null)
    }
    setOpen(next)
  }

  const remnawaveId = candidate.trim()
  const idIsNumeric = isNumericRemnawaveId(remnawaveId)
  // Only complain about something the operator actually typed: an empty field
  // is "not started", not "wrong".
  const showIdError = remnawaveId.length > 0 && !idIsNumeric
  const canSubmit = idIsNumeric && chosen !== null && !mutation.isPending

  const submit = (): void => {
    if (!canSubmit || chosen === null) return
    setFailure(null)
    mutation.mutate({ subscriptionId: chosen, remnawaveId, confirmedWithoutProof })
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 whitespace-nowrap">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('subscriptionTools.linkDialog.action')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('subscriptionTools.linkDialog.title')}</DialogTitle>
          <DialogDescription>{t('subscriptionTools.linkDialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {onlyTarget !== undefined ? (
            <p className="text-sm">
              {t('subscriptionTools.linkDialog.subscription', { subscription: onlyTarget.label })}
            </p>
          ) : (
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">
                {t('subscriptionTools.linkDialog.pickSubscription')}
              </legend>
              <p className="text-xs text-muted-foreground">
                {t('subscriptionTools.linkDialog.pickSubscriptionHint')}
              </p>
              {targets.map((target) => (
                <label
                  key={target.subscriptionId}
                  className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-xs"
                >
                  <input
                    type="radio"
                    name={`${fieldId}-subscription`}
                    value={target.subscriptionId}
                    checked={chosen === target.subscriptionId}
                    onChange={() => setChosen(target.subscriptionId)}
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                  />
                  <span>{target.label}</span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-id`}>{t('subscriptionTools.linkDialog.idLabel')}</Label>
            <Input
              id={`${fieldId}-id`}
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              placeholder={t('subscriptionTools.linkDialog.idPlaceholder')}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={showIdError}
              aria-describedby={showIdError ? `${fieldId}-id-hint ${fieldId}-id-error` : `${fieldId}-id-hint`}
            />
            <p id={`${fieldId}-id-hint`} className="text-xs text-muted-foreground">
              {t('subscriptionTools.linkDialog.idHint')}
            </p>
            {showIdError ? (
              <p id={`${fieldId}-id-error`} role="alert" className="text-sm text-destructive">
                {t('subscriptionTools.linkDialog.idInvalid')}
              </p>
            ) : null}
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id={`${fieldId}-confirm`}
              checked={confirmedWithoutProof}
              onCheckedChange={(checked) => setConfirmedWithoutProof(checked === true)}
              aria-describedby={`${fieldId}-confirm-hint`}
            />
            <div className="space-y-0.5">
              <Label htmlFor={`${fieldId}-confirm`} className="text-sm font-normal">
                {t('subscriptionTools.linkDialog.confirm')}
              </Label>
              <p id={`${fieldId}-confirm-hint`} className="text-xs text-muted-foreground">
                {t('subscriptionTools.linkDialog.confirmHint')}
              </p>
            </div>
          </div>

          {failure === null ? null : (
            <Alert variant="destructive">
              <AlertTitle>{t('subscriptionTools.linkDialog.failedTitle')}</AlertTitle>
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {t('subscriptionTools.linkDialog.submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
