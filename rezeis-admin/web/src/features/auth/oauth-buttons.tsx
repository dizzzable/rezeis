import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Loader2, KeyRound, Send } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { api } from '@/lib/api'

import { useAuth } from './auth-provider'

interface PublicProvider {
  type: string
  displayName: string
  isEnabled: boolean
}

const PROVIDER_ICONS: Record<string, React.ElementType> = {
  TELEGRAM: Send,
  GITHUB: KeyRound,
  YANDEX: () => <span className="text-sm font-bold">Я</span>,
  KEYCLOAK: KeyRound,
  POCKETID: KeyRound,
  GENERIC_OAUTH2: KeyRound,
}

/**
 * OAuth login buttons shown on the sign-in page.
 * Only renders if there are enabled providers.
 */
export function OAuthButtons() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuth()

  const { data: providers, isLoading } = useQuery({
    queryKey: ['oauth', 'providers'],
    queryFn: async () => {
      const res = await api.get<PublicProvider[]>('/admin/oauth/providers')
      return res.data
    },
    staleTime: 60_000,
  })

  const telegramMutation = useMutation({
    mutationFn: async (data: Record<string, string>) => {
      const res = await api.post<{ accessToken: string }>('/admin/oauth/telegram/login', data)
      return res.data
    },
    onSuccess: (data) => {
      login(data.accessToken)
      navigate('/', { replace: true })
    },
  })

  if (isLoading || !providers || providers.length === 0) {
    return null
  }

  const handleGitHub = () => {
    window.location.href = '/api/admin/oauth/github/authorize'
  }

  const handlePasskey = async () => {
    try {
      // Get authentication options
      const optionsRes = await api.post<Record<string, unknown>>('/admin/passkey/authenticate/options', {})
      const options = optionsRes.data

      // Call WebAuthn browser API
      const credential = await navigator.credentials.get({
        publicKey: options as unknown as PublicKeyCredentialRequestOptions,
      }) as PublicKeyCredential | null

      if (!credential) return

      const response = credential.response as AuthenticatorAssertionResponse

      // Send to backend for verification
      const verifyRes = await api.post<{ accessToken: string }>('/admin/passkey/authenticate/verify', {
        response: {
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            authenticatorData: bufferToBase64url(response.authenticatorData),
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            signature: bufferToBase64url(response.signature),
            userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
          },
        },
      })

      login(verifyRes.data.accessToken)
      navigate('/', { replace: true })
    } catch {
      // User cancelled or error — silently ignore
    }
  }

  // Check if passkey is supported
  const passkeySupported = typeof window !== 'undefined' && 'credentials' in navigator

  return (
    <>
      <div className="relative my-4">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
          {t('signInPage.oauth.or')}
        </span>
      </div>

      <div className="space-y-2">
        {providers.map((provider) => {
          const Icon = PROVIDER_ICONS[provider.type] ?? KeyRound

          if (provider.type === 'GITHUB') {
            return (
              <Button
                key={provider.type}
                variant="outline"
                className="w-full gap-2"
                onClick={handleGitHub}
              >
                <Icon className="h-4 w-4" />
                {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
              </Button>
            )
          }

          if (provider.type === 'TELEGRAM') {
            return (
              <Button
                key={provider.type}
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  // Telegram Login Widget will be handled via the widget script
                  // For now, show a placeholder
                  telegramMutation.mutate({})
                }}
                disabled={telegramMutation.isPending}
              >
                {telegramMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Icon className="h-4 w-4" />
                )}
                {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
              </Button>
            )
          }

          return (
            <Button
              key={provider.type}
              variant="outline"
              className="w-full gap-2"
              onClick={() => {
                window.location.href = `/api/admin/oauth/${provider.type.toLowerCase()}/authorize`
              }}
            >
              <Icon className="h-4 w-4" />
              {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
            </Button>
          )
        })}

        {passkeySupported && (
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={handlePasskey}
          >
            <KeyRound className="h-4 w-4" />
            {t('signInPage.oauth.passkey')}
          </Button>
        )}
      </div>
    </>
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
