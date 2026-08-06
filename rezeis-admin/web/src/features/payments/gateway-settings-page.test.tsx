import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'

import { usePermissionStore, type RbacAction } from '@/features/rbac'
import { i18n, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import GatewaySettingsPage from './gateway-settings-page'

describe('GatewaySettingsPage RBAC gating', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('does not fetch gateway settings without payment_gateways:view', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    grantPermissions([])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('Payment gateway access is restricted')).toBeInTheDocument()
    expect(getSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Create default gateways' })).not.toBeInTheDocument()
  })

  it('shows gateway settings read-only without payment_gateways:edit', async () => {
    mockGatewayList([
      createGateway({
        settings: { shopId: 'shop-1', apiKey: 'secret-key' },
        isConfigured: true,
      }),
    ])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add missing' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Toggle active' })).not.toBeInTheDocument()
  })
})

describe('GatewaySettingsPage readiness', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('trusts the backend verdict rather than the presence of any single setting', async () => {
    mockGatewayList([
      // One filled field used to be enough for the panel to call this ready;
      // the backend needs both `shopId` and a key before it issues a checkout.
      // Switched off, so this is the quiet setup-hint path — the enabled-and-
      // broken row has its own, much louder treatment (see the fault suite).
      createGateway({ isActive: false, settings: { shopId: 'shop-1' }, isConfigured: false }),
    ])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.getByText('Not configured')).toBeInTheDocument()
  })

  it('hides the not-configured badge when the backend reports the gateway ready', async () => {
    mockGatewayList([
      createGateway({ settings: { shopId: 'shop-1', apiKey: 'key-1' }, isConfigured: true }),
    ])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument()
  })

  it('explains the backend refusal instead of leaking the product code', async () => {
    mockGatewayList([createGateway({ isActive: false, isConfigured: false })])
    vi.spyOn(api, 'patch').mockRejectedValue({
      response: { data: { message: 'PAYMENT_GATEWAY_NOT_CONFIGURED' } },
    })
    const errorToast = vi.spyOn(toast, 'error').mockReturnValue('toast-1')
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('switch', { name: 'Toggle active' }))

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        'This gateway cannot be enabled until its required credentials are filled in. Open the settings, enter them and save.',
      )
    })
  })

  it('no longer offers the test-request button that only re-read the row', async () => {
    mockGatewayList([createGateway({ isConfigured: true })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByRole('button', { name: 'Open settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test request' })).not.toBeInTheDocument()
  })
})

/**
 * `isActive && !isConfigured` is the dangerous combination: the checkout guard
 * reads the same `isConfigured` this page does and answers
 * `PAYMENT_GATEWAY_NOT_CONFIGURED` (400), so the gateway is live in the picker
 * and dead at the till. It became reachable without anyone touching the panel
 * when the webhook credential joined the required set for six providers — the
 * row had to stop reading like a setup hint and start reading like an outage.
 */
describe('GatewaySettingsPage enabled-but-unconfigured fault', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('reports an enabled gateway the backend cannot charge on as an outage', async () => {
    // RollyPay holding only `apiKey` — a working gateway right up until
    // `signingSecret` became mandatory. The operator has no reason to touch
    // the toggle, which used to be the only place the panel said anything.
    mockGatewayList([createRollyPayMissingSigningSecret()])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('RollyPay')).toBeInTheDocument()
    expect(screen.getByText('Not taking payments')).toBeInTheDocument()
    expect(screen.getByText(/switched on but cannot take a payment/i)).toBeInTheDocument()
    // «Not configured» is what an untouched gateway says; an outage must not
    // be reported in the same words.
    expect(screen.queryByText('Not configured')).not.toBeInTheDocument()
  })

  it('raises a page-level banner naming every gateway that is losing payments', async () => {
    mockGatewayList([
      createRollyPayMissingSigningSecret(),
      createGateway({
        id: 'gateway-2',
        type: 'LAVA',
        orderIndex: 2,
        settings: { apiKey: 'lava-key-1', offerId: 'offer-1' },
        isConfigured: false,
      }),
      createGateway({
        id: 'gateway-3',
        orderIndex: 3,
        settings: { shopId: 'shop-1', apiKey: 'key-1' },
        isConfigured: true,
      }),
    ])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('Payments are failing')
    expect(banner).toHaveTextContent('RollyPay, Lava.top')
    expect(banner).not.toHaveTextContent('YooKassa')
  })

  it('stops presenting a faulted default gateway as the endorsed one', async () => {
    mockGatewayList([createRollyPayMissingSigningSecret()])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    // The badge stays — that the broken rail is the one buyers meet first is
    // the worst part of this and must not be hidden — but it loses the solid
    // primary fill that reads as an endorsement.
    const badge = await screen.findByText('Default')
    expect(badge.className).not.toMatch(/bg-primary/)
    expect(badge.className).toMatch(/destructive/)
    expect(screen.getByText(/sits first in the list/i)).toBeInTheDocument()
  })

  it('says nothing alarming about a gateway the backend reports ready', async () => {
    mockGatewayList([
      createGateway({ settings: { shopId: 'shop-1', apiKey: 'key-1' }, isConfigured: true }),
    ])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.queryByText('Not taking payments')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves an unconfigured gateway that is switched off quiet', async () => {
    // The resting state of the fifteen gateways nobody uses. A wall of
    // warnings here would bury the one row that is actually losing money.
    mockGatewayList([createGateway({ isActive: false, isConfigured: false })])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.queryByText('Not taking payments')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Still labelled, but as the setup hint it is: the alarm palette is
    // reserved for the enabled-and-broken row, or the new signal is worth
    // nothing on a page where every idle gateway shouts too.
    expect(screen.getByText('Not configured').className).not.toMatch(/amber|destructive/)
  })

  it('does not paint a live gateway as active-and-fine when the panel is read-only', async () => {
    mockGatewayList([createRollyPayMissingSigningSecret()])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    // The read-only column states the truth — the gateway *is* active — but
    // the success-green it used to be dressed in was half of the lie.
    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Active').className).not.toMatch(/green/)
  })
})

/**
 * Russian is the operator's language on every deployment this panel ships to;
 * an outage notice that only exists in English is an outage notice nobody
 * reads. Restores the locale afterwards — `i18n` is module-global.
 */
describe('GatewaySettingsPage fault wording in Russian', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('payments')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('reports the outage in Russian as well as English', async () => {
    mockGatewayList([createRollyPayMissingSigningSecret()])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('RollyPay')).toBeInTheDocument()
    expect(screen.getByText('Не принимает оплату')).toBeInTheDocument()
    expect(screen.getByText(/Шлюз включён, но принять оплату не может/)).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Оплата не проходит')
  })

  it('keeps a switched-off unconfigured gateway quiet in Russian too', async () => {
    mockGatewayList([createGateway({ isActive: false, isConfigured: false })])
    grantPermissions([{ resource: 'payment_gateways', action: 'view' }])

    renderWithProviders(<GatewaySettingsPage />)

    expect(await screen.findByText('YooKassa')).toBeInTheDocument()
    expect(screen.getByText('Не настроен')).toBeInTheDocument()
    expect(screen.queryByText('Не принимает оплату')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('GatewaySettingsPage webhook URL and Wata fields', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('renders the absolute webhook URL and copies it to the clipboard', async () => {
    mockGatewayList([
      createGateway({
        type: 'WATA',
        currency: 'RUB',
        isConfigured: true,
        webhookUrl: 'https://panel.example.com/api/v1/payments/webhooks/WATA',
      }),
    ])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()
    // `userEvent.setup()` installs its own `navigator.clipboard` stub, so ours
    // has to be defined afterwards or the click writes into theirs.
    const writeText = mockClipboard()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(
      await screen.findByText('https://panel.example.com/api/v1/payments/webhooks/WATA'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(
      'https://panel.example.com/api/v1/payments/webhooks/WATA',
    )
  })

  it('offers Wata a public key field instead of the dead webhook secret', async () => {
    mockGatewayList([createGateway({ type: 'WATA', currency: 'RUB', isConfigured: true })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Public key (Base64)')).toBeInTheDocument()
    expect(screen.queryByText('Webhook secret')).not.toBeInTheDocument()
  })
})

describe('GatewaySettingsPage Platega payment method', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
    installSelectJsdomShims()
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('offers Platega the provider enum with card acquiring named, and no method 1', async () => {
    mockGatewayList([createPlatega()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Platega payment method' }))

    // Every label carries the provider's own number because that is what the
    // Platega dashboard and its support speak in — and because the ambiguity
    // is the bug that started this: `CARD` used to be sent as 1, a method
    // Platega does not have, with nothing in the UI to reveal it.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      // Numberless on purpose: it is not one of Platega's rails, it is the
      // choice to send no rail and let Platega ask the payer.
      'Payer picks the method on Platega',
      '2 — СБП / SBP (QR code)',
      '3 — ЕРИП / ERIP',
      '11 — Card acquiring',
      '12 — International payments',
      '13 — Cryptocurrency',
      '14 — SberPay',
    ])
  })

  it('posts the provider-choice sentinel the backend enum accepts, not a blank', async () => {
    mockGatewayList([createPlatega()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Platega payment method' }))
    await user.click(screen.getByRole('option', { name: 'Payer picks the method on Platega' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // An explicitly-stored value, NOT an omitted key: an absent `paymentMethod`
    // still means СБП (2) at checkout, so «provider's choice» has to travel as
    // a value of its own or it would be indistinguishable from never choosing.
    expect(readSavedSettings(patchSpy)).toEqual({
      merchantId: 'merchant-1',
      secret: 'secret-1',
      paymentMethod: 'PROVIDER_CHOICE',
    })
  })

  it('keeps the provider-choice sentinel selected on reopen', async () => {
    mockGatewayList([createPlatega({ paymentMethod: 'PROVIDER_CHOICE' })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(
      await screen.findByRole('combobox', { name: 'Platega payment method' }),
    ).toHaveTextContent('Payer picks the method on Platega')
  })

  it('sends the chosen payment method in a shape the backend enum accepts', async () => {
    mockGatewayList([createPlatega()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Platega payment method' }))
    await user.click(screen.getByRole('option', { name: '11 — Card acquiring' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    expect(readSavedSettings(patchSpy)).toEqual({
      merchantId: 'merchant-1',
      secret: 'secret-1',
      // `'11'` is a member of the backend's accepted enum and normalizes to
      // the number 11 on storage; the label the operator read is not sent.
      paymentMethod: '11',
    })
  })

  it('keeps a payment method the backend stored as a number selected on reopen', async () => {
    mockGatewayList([createPlatega({ paymentMethod: 11 })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(
      await screen.findByRole('combobox', { name: 'Platega payment method' }),
    ).toHaveTextContent('11 — Card acquiring')
  })

  it('does not offer the payment-method selector to other gateways', async () => {
    mockGatewayList([createGateway({ type: 'RIOPAY', settings: { apiToken: 'token-1' } })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Service ID')).toBeInTheDocument()
    expect(screen.queryByText('Platega payment method')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Platega payment method' }),
    ).not.toBeInTheDocument()
  })
})

describe('GatewaySettingsPage RioPay/Valutix serviceId', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
    installSelectJsdomShims()
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it.each(['RIOPAY', 'VALUTIX'])('offers %s a serviceId field', async (type) => {
    mockGatewayList([createGateway({ type, settings: { apiToken: 'token-1' } })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Service ID')).toBeInTheDocument()
  })

  it('does not offer serviceId to gateways that do not route through a service', async () => {
    mockGatewayList([createPlatega()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Merchant ID')).toBeInTheDocument()
    expect(screen.queryByText('Service ID')).not.toBeInTheDocument()
  })

  it('does not send a serviceId the operator left blank', async () => {
    mockGatewayList([createGateway({ type: 'RIOPAY', settings: { apiToken: 'token-1' } })])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // Legacy single-service accounts have nothing to put here, and the value
    // is parsed as a number — a `''` must leave as an absent key, not as an
    // empty string the schema would have to special-case.
    const settings = readSavedSettings(patchSpy)
    expect(settings).not.toHaveProperty('serviceId')
    expect(settings).toEqual({ apiToken: 'token-1' })
  })

  it('round-trips a serviceId the backend stored as a number', async () => {
    mockGatewayList([
      createGateway({ type: 'RIOPAY', settings: { apiToken: 'token-1', serviceId: 7 } }),
    ])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByDisplayValue('7')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    expect(readSavedSettings(patchSpy)).toEqual({ apiToken: 'token-1', serviceId: '7' })
  })
})

describe('GatewaySettingsPage Antilopay VAT rate', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
    installSelectJsdomShims()
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('offers Antilopay both rates and a reachable «not set» choice', async () => {
    mockGatewayList([createAntilopay()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Antilopay VAT rate' }))

    // Antilopay accepts 10 and 22 and nothing else, so those are the only
    // rates offered — but a merchant on УСН/НПД must send no rate at all,
    // and Radix refuses an empty `SelectItem`, so «not set» needs its own
    // entry or opening the list would be a one-way door.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Not set',
      '10% — reduced rate',
      '22% — standard rate',
    ])
  })

  it('sends the chosen VAT rate in a shape the backend enum accepts', async () => {
    mockGatewayList([createAntilopay()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Antilopay VAT rate' }))
    await user.click(screen.getByRole('option', { name: '10% — reduced rate' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    expect(readSavedSettings(patchSpy)).toEqual({
      projectIdentificator: 'project-1',
      secretId: 'secret-id-1',
      privateKey: 'private-key-1',
      publicKey: 'public-key-1',
      // `'10'` is a member of the backend's accepted enum and normalizes to
      // the number 10 on storage; the label the operator read is not sent.
      vat: '10',
    })
  })

  it('keeps a VAT rate the backend stored as a number selected on reopen', async () => {
    mockGatewayList([createAntilopay({ vat: 22 })])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    // Storage normalizes the rate to a number; reading it as "not a string,
    // therefore blank" would show an unset field and the next save would drop
    // a setting the operator never touched — for a merchant on ОСНО that is
    // every checkout failing with error 17 again.
    expect(
      await screen.findByRole('combobox', { name: 'Antilopay VAT rate' }),
    ).toHaveTextContent('22% — standard rate')
  })

  it('does not send a VAT rate the operator left unset', async () => {
    mockGatewayList([createAntilopay()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // УСН/НПД merchants have no rate to declare, and the value is parsed as a
    // number — an untouched field must leave as an absent key, not a blank
    // the enum would reject and fail the whole save on.
    expect(readSavedSettings(patchSpy)).not.toHaveProperty('vat')
  })

  it('clears a stored VAT rate back to unset without sending a blank', async () => {
    mockGatewayList([createAntilopay({ vat: 10 })])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.click(await screen.findByRole('combobox', { name: 'Antilopay VAT rate' }))
    await user.click(screen.getByRole('option', { name: 'Not set' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // Settings are replaced rather than merged, so dropping the key is what
    // un-stores the rate — the placeholder stand-in the entry carries must
    // never reach the wire.
    expect(readSavedSettings(patchSpy)).toEqual({
      projectIdentificator: 'project-1',
      secretId: 'secret-id-1',
      privateKey: 'private-key-1',
      publicKey: 'public-key-1',
    })
  })

  it('does not offer the VAT selector to other gateways', async () => {
    mockGatewayList([createPlatega()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Merchant ID')).toBeInTheDocument()
    expect(screen.queryByText('Antilopay VAT rate')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Antilopay VAT rate' }),
    ).not.toBeInTheDocument()
  })
})

/**
 * Credentials are encrypted at rest and reads are permission-gated. Without
 * `payment_gateways:view_secrets` — which no system role holds by default — the
 * API answers with `********` plus the real last 4 characters and says so via
 * `secretsVisible` / `configuredSecretKeys`.
 *
 * The form rendered that straight into the field, so an operator who still
 * holds `edit` (and is expected to keep working) met an unexplained
 * `********c8e5` with nothing to say whether the value was hidden or corrupted.
 * Worse, typing over it produced `********c8e5my-new-key`, and the backend
 * recognises a mask permissively — anything starting with `********` means
 * «unchanged» — so the rotation was dropped and the save reported success.
 */
describe('GatewaySettingsPage hidden gateway secrets', () => {
  beforeAll(async () => {
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('explains a masked secret instead of leaving ******** unaccounted for', async () => {
    mockGatewayList([createMaskedRollyPay()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByText('Credentials are hidden')).toBeInTheDocument()
    expect(
      screen.getByText(/A field you leave untouched keeps its stored key/),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/stored and hidden from your role/)).toHaveLength(2)
    // The mask stays readable rather than collapsing into twelve anonymous
    // bullets: its last 4 characters are the whole reason the backend sends
    // them — they identify WHICH key is installed.
    expect(screen.getByDisplayValue('********c8e5')).toHaveAttribute('type', 'text')
    // And there is nothing behind it to reveal, so nothing offers to.
    expect(screen.queryByRole('button', { name: 'Show secret' })).not.toBeInTheDocument()
  })

  it('stays silent about masking for a caller who can read the real values', async () => {
    mockGatewayList([
      createMaskedRollyPay({
        settings: { apiKey: 'rpk_live_1', signingSecret: 'signing-1' },
        secretsVisible: true,
      }),
    ])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByDisplayValue('rpk_live_1')).toBeInTheDocument()
    // `configuredSecretKeys` is reported identically to both audiences, so it
    // must not be what triggers the wording — a superadmin told about a
    // redaction that never happened to them is noise, and this page has spent
    // two reworks getting noise out of the way of the one real alarm.
    expect(screen.queryByText('Credentials are hidden')).not.toBeInTheDocument()
    expect(screen.queryByText(/stored and hidden from your role/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Show secret' })).toHaveLength(2)
  })

  it('does not describe a secret field with nothing stored as hidden', async () => {
    // The RollyPay that went dark when `signingSecret` joined the required set,
    // seen by an operator who cannot read secrets: one credential stored and
    // masked, the other genuinely absent. Calling the empty one «hidden» would
    // send them hunting for a permission instead of pasting the missing key.
    mockGatewayList([
      createMaskedRollyPay({
        isActive: false,
        isConfigured: false,
        settings: { apiKey: '********c8e5' },
        configuredSecretKeys: ['apiKey'],
      }),
    ])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))

    expect(await screen.findByDisplayValue('********c8e5')).toBeInTheDocument()
    expect(screen.getAllByText(/stored and hidden from your role/)).toHaveLength(1)
    // Not set is not hidden: an ordinary empty secret input, dots and a reveal
    // toggle for whatever gets typed into it.
    const missingSecret = screen.getByPlaceholderText('signing_secret')
    expect(missingSecret).toHaveValue('')
    expect(missingSecret).toHaveAttribute('type', 'password')
    expect(screen.getAllByRole('button', { name: 'Show secret' })).toHaveLength(1)
  })

  it('replaces a masked secret with what was typed rather than appending to the mask', async () => {
    mockGatewayList([createMaskedRollyPay()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.type(await screen.findByDisplayValue('********c8e5'), 'rpk_live_rotated')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // `********c8e5rpk_live_rotated` is not merely an ugly value: it starts with
    // the mask body, which the backend reads as «keep what is stored», so the
    // rotation would be silently dropped and the save would still say «saved».
    expect(readSavedSettings(patchSpy).apiKey).toBe('rpk_live_rotated')
  })

  it('keeps an untouched masked secret unchanged while its neighbour is rotated', async () => {
    mockGatewayList([createMaskedRollyPay()])
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Open settings' }))
    await user.type(await screen.findByDisplayValue('********f00d'), 'signing-rotated')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patchSpy).toHaveBeenCalled())
    // Echoing the mask back verbatim is what «unchanged» means on the wire.
    // Settings are replaced rather than merged, so an `apiKey` that arrives as
    // anything else — trimmed, blanked, or carrying the neighbour's edit —
    // overwrites a live credential and takes the gateway down.
    expect(readSavedSettings(patchSpy)).toEqual({
      apiKey: '********c8e5',
      signingSecret: 'signing-rotated',
    })
  })
})

describe('GatewaySettingsPage hidden-secret wording in Russian', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru')
    await loadFeatureBundle('payments')
  })

  afterAll(async () => {
    await i18n.changeLanguage('en')
    await loadFeatureBundle('payments')
  })

  beforeEach(() => {
    usePermissionStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('explains the mask in Russian as well as English', async () => {
    mockGatewayList([createMaskedRollyPay()])
    grantPermissions([
      { resource: 'payment_gateways', action: 'view' },
      { resource: 'payment_gateways', action: 'edit' },
    ])
    const user = userEvent.setup()

    renderWithProviders(<GatewaySettingsPage />)
    await user.click(await screen.findByRole('button', { name: 'Открыть настройки' }))

    expect(await screen.findByText('Учётные данные скрыты')).toBeInTheDocument()
    expect(
      screen.getByText(/Поле, которое вы не трогали, сохранит прежний ключ/),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/Ключ сохранён и скрыт от вашей роли/)).toHaveLength(2)
  })
})

interface GatewayFixture {
  id: string
  type: string
  currency: string
  isActive: boolean
  orderIndex: number
  settings: Record<string, unknown>
  isConfigured: boolean
  secretsVisible: boolean
  configuredSecretKeys: readonly string[]
  webhookUrl: string
  updatedAt: string
}

function createGateway(overrides: Partial<GatewayFixture> = {}): GatewayFixture {
  const type = overrides.type ?? 'YOOKASSA'
  return {
    id: 'gateway-1',
    type,
    currency: 'RUB',
    isActive: true,
    orderIndex: 1,
    settings: {},
    isConfigured: false,
    // Superadmin's view by default: real values, nothing to explain. The
    // permission-gated view is opted into per fixture.
    secretsVisible: true,
    configuredSecretKeys: [],
    webhookUrl: `https://panel.example.com/api/v1/payments/webhooks/${type}`,
    updatedAt: '2026-06-03T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * RollyPay exactly as the API renders it for a caller without
 * `payment_gateways:view_secrets`: both credentials stored, both replaced by
 * `********` plus their real last 4 characters, and `configuredSecretKeys`
 * naming them regardless of that permission.
 */
function createMaskedRollyPay(overrides: Partial<GatewayFixture> = {}): GatewayFixture {
  return createGateway({
    type: 'ROLLYPAY',
    isConfigured: true,
    settings: { apiKey: '********c8e5', signingSecret: '********f00d' },
    secretsVisible: false,
    configuredSecretKeys: ['apiKey', 'signingSecret'],
    ...overrides,
  })
}

/**
 * The regression, verbatim: a RollyPay that took payments for months on its
 * `apiKey` alone, then went unconfigured overnight when `signingSecret` joined
 * the required set. Still active, still first in the list, still the rail the
 * buyer is offered — and every checkout on it now answers 400.
 */
function createRollyPayMissingSigningSecret(
  overrides: Partial<GatewayFixture> = {},
): GatewayFixture {
  return createGateway({
    type: 'ROLLYPAY',
    isActive: true,
    isConfigured: false,
    settings: { apiKey: 'rpk_live_1' },
    ...overrides,
  })
}

function createPlatega(settings: Record<string, unknown> = {}): GatewayFixture {
  return createGateway({
    type: 'PLATEGA',
    isConfigured: true,
    settings: { merchantId: 'merchant-1', secret: 'secret-1', ...settings },
  })
}

function createAntilopay(settings: Record<string, unknown> = {}): GatewayFixture {
  return createGateway({
    type: 'ANTILOPAY',
    isConfigured: true,
    settings: {
      projectIdentificator: 'project-1',
      secretId: 'secret-id-1',
      privateKey: 'private-key-1',
      publicKey: 'public-key-1',
      ...settings,
    },
  })
}

/**
 * Radix's Select drives its listbox through the Pointer Capture APIs and
 * `scrollIntoView`, none of which jsdom implements — without these stubs
 * clicking the trigger throws instead of opening the dropdown.
 */
function installSelectJsdomShims(): void {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
  Element.prototype.scrollIntoView = (): void => {}
}

/** The `settings` object of the first PATCH the form issued. */
function readSavedSettings(patchSpy: {
  readonly mock: { readonly calls: readonly unknown[][] }
}): Record<string, unknown> {
  const [, body] = patchSpy.mock.calls[0] as [string, { settings: Record<string, unknown> }]
  return body.settings
}

/**
 * The settings dialog pulls the supported-currency map from a second endpoint,
 * so the stub has to answer per URL rather than with one blanket payload.
 */
function mockGatewayList(gateways: readonly GatewayFixture[]): void {
  vi.spyOn(api, 'get').mockImplementation(async (url: string) =>
    url.endsWith('/supported-currencies') ? { data: {} } : { data: gateways },
  )
}

function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

function grantPermissions(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}
