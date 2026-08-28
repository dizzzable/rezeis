/**
 * The filter panel beside the user search box.
 *
 * ── A popover, not a sidebar ─────────────────────────────────────────────
 *
 * The Users page is already two panels wide and the list column is narrow. A
 * third permanent column would take space from the list on every visit for the
 * sake of controls used on some of them; the trigger carries a count so the
 * state is visible without opening anything.
 *
 * ── Tri-states are buttons, not checkboxes ───────────────────────────────
 *
 * "Blocked", "not blocked" and "either" are three answers, and a checkbox has
 * two. Rendering them as checkboxes is how a filter ends up silently excluding
 * everybody it was never asked about.
 */
import { useTranslation } from 'react-i18next'
import { Filter, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { usePlans } from '@/features/plans/plans-api'
import { cn } from '@/lib/utils'
import {
  countActiveFilters,
  cycleTriState,
  EMPTY_FILTERS,
  SUBSCRIPTION_STATUSES,
  toggleListValue,
  TRI_STATE_KEYS,
  type TriState,
  type TriStateKey,
  type UserFilters,
  USER_LANGUAGES,
  USER_ROLES,
} from './users-filters'

interface UsersFilterPanelProps {
  readonly filters: UserFilters
  readonly onChange: (next: UserFilters) => void
}

export function UsersFilterPanel({ filters, onChange }: UsersFilterPanelProps) {
  const { t } = useTranslation()
  const active = countActiveFilters(filters)
  // Plans are only needed once the panel is open, and the list can be long on a
  // mature install — no reason to fetch it for everybody who opens Users.
  const plansQuery = usePlans()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('usersPage.filters.open')}>
          <Filter className="h-4 w-4" />
          {active > 0 && (
            <Badge
              variant="default"
              className="absolute -right-1.5 -top-1.5 h-4 min-w-4 justify-center px-1 text-[10px] tabular-nums"
            >
              {active}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium">{t('usersPage.filters.title')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={active === 0}
            onClick={() => onChange(EMPTY_FILTERS)}
          >
            <X className="mr-1 h-3 w-3" />
            {t('usersPage.filters.clear')}
          </Button>
        </div>
        <Separator />
        <ScrollArea className="max-h-[26rem]">
          <div className="space-y-4 p-3">
            <TriStateGroup filters={filters} onChange={onChange} />

            <FilterGroup title={t('usersPage.filters.groups.plan')}>
              {plansQuery.data === undefined || plansQuery.data.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {plansQuery.isLoading
                    ? t('common.loading')
                    : t('usersPage.filters.noPlans')}
                </p>
              ) : (
                plansQuery.data.map((plan) => (
                  <CheckboxRow
                    key={plan.id}
                    id={`filter-plan-${plan.id}`}
                    label={plan.name}
                    checked={filters.planIds.includes(plan.id)}
                    onToggle={() => onChange(toggleListValue(filters, 'planIds', plan.id))}
                  />
                ))
              )}
            </FilterGroup>

            <FilterGroup title={t('usersPage.filters.groups.subscriptionStatus')}>
              {SUBSCRIPTION_STATUSES.map((status) => (
                <CheckboxRow
                  key={status}
                  id={`filter-status-${status}`}
                  label={t(`usersPage.filters.subscriptionStatus.${status}`, status)}
                  checked={filters.subscriptionStatuses.includes(status)}
                  onToggle={() =>
                    onChange(toggleListValue(filters, 'subscriptionStatuses', status))
                  }
                />
              ))}
            </FilterGroup>

            <FilterGroup title={t('usersPage.filters.groups.role')}>
              {USER_ROLES.map((role) => (
                <CheckboxRow
                  key={role}
                  id={`filter-role-${role}`}
                  label={role}
                  checked={filters.roles.includes(role)}
                  onToggle={() => onChange(toggleListValue(filters, 'roles', role))}
                />
              ))}
            </FilterGroup>

            <FilterGroup title={t('usersPage.filters.groups.language')}>
              {USER_LANGUAGES.map((language) => (
                <CheckboxRow
                  key={language}
                  id={`filter-language-${language}`}
                  label={language}
                  checked={filters.languages.includes(language)}
                  onToggle={() => onChange(toggleListValue(filters, 'languages', language))}
                />
              ))}
            </FilterGroup>
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

function FilterGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function CheckboxRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onToggle} />
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}

function TriStateGroup({
  filters,
  onChange,
}: {
  filters: UserFilters
  onChange: (next: UserFilters) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-1.5">
      {TRI_STATE_KEYS.map((key) => (
        <TriStateChip
          key={key}
          label={t(`usersPage.filters.tri.${key}`)}
          value={filters[key]}
          onCycle={() => onChange(cycleTriState(filters, key as TriStateKey))}
        />
      ))}
    </div>
  )
}

/**
 * One tri-state, cycling unset → yes → no → unset.
 *
 * The state is carried by BOTH colour and a prefix character, because "yes" and
 * "no" as two shades of the same chip is a distinction somebody scanning the
 * panel will not make — and reading it backwards means filtering for exactly
 * the people you meant to exclude.
 */
function TriStateChip({
  label,
  value,
  onCycle,
}: {
  label: string
  value: TriState
  onCycle: () => void
}) {
  const { t } = useTranslation()
  const state = value === undefined ? 'any' : value ? 'yes' : 'no'
  return (
    <button
      type="button"
      onClick={onCycle}
      aria-label={`${label}: ${t(`usersPage.filters.state.${state}`)}`}
      className={cn(
        'rounded-full border px-2.5 py-1 text-xs transition-colors',
        value === undefined && 'border-border text-muted-foreground hover:bg-muted',
        value === true && 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600',
        value === false && 'border-destructive/50 bg-destructive/10 text-destructive',
      )}
    >
      {value === true ? '✓ ' : value === false ? '✕ ' : ''}
      {label}
    </button>
  )
}
