/**
 * Inline auth-provider icons for the OAuth2/SSO settings UI.
 *
 * The SVG markup is inlined here so the bundler can tree-shake unused icons
 * and so we don't depend on any external icon hosting. PocketID ships as a
 * PNG (not vector), so we inline it as a base64 data URI inside an <img>.
 *
 * All icons accept a single `className` prop and render at the natural size
 * of the parent (`h-4 w-4` etc.). They use `currentColor` where possible so
 * the surrounding tailwind text-color classes still apply for the SVGs that
 * support it (`Oauth2`). For brand-locked icons (GitHub, Yandex, Keycloak)
 * we keep the original brand colors hardcoded.
 */

import { Send } from 'lucide-react'
import type { JSX } from 'react'

export type AuthProviderIconType =
  | 'TELEGRAM'
  | 'GITHUB'
  | 'YANDEX'
  | 'KEYCLOAK'
  | 'POCKETID'
  | 'GENERIC_OAUTH2'

interface IconProps {
  readonly className?: string
}

export function GitHubIcon({ className }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.026 2c-5.509 0-9.974 4.465-9.974 9.974c0 4.406 2.857 8.145 6.821 9.465c.499.09.679-.217.679-.481c0-.237-.008-.865-.011-1.696c-2.775.602-3.361-1.338-3.361-1.338c-.452-1.152-1.107-1.459-1.107-1.459c-.905-.619.069-.605.069-.605c1.002.07 1.527 1.028 1.527 1.028c.89 1.524 2.336 1.084 2.902.829c.091-.645.351-1.085.635-1.334c-2.214-.251-4.542-1.107-4.542-4.93c0-1.087.389-1.979 1.024-2.675c-.101-.253-.446-1.268.099-2.64c0 0 .837-.269 2.742 1.021a9.582 9.582 0 0 1 2.496-.336a9.554 9.554 0 0 1 2.496.336c1.906-1.291 2.742-1.021 2.742-1.021c.545 1.372.203 2.387.099 2.64c.64.696 1.024 1.587 1.024 2.675c0 3.833-2.33 4.675-4.552 4.922c.355.308.675.916.675 1.846c0 1.334-.012 2.41-.012 2.737c0 .267.178.577.687.479C19.146 20.115 22 16.379 22 11.974C22 6.465 17.535 2 12.026 2z"
        fill="currentColor"
      />
    </svg>
  )
}

export function KeycloakIcon({ className }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="m18.742 1.182l-12.493.002C4.155 4.784 2.079 8.393 0 12.002c2.071 3.612 4.162 7.214 6.252 10.816l12.49-.004l3.089-5.404h2.158v-.002H24L23.996 6.59h-2.168zM8.327 4.792h2.081l1.04 1.8l-3.12 5.413l3.117 5.403l-1.035 1.81H8.327a2048 2048 0 0 0-4.168-7.204zm6.241 0l2.086.003q2.088 3.608 4.166 7.222l-4.167 7.2h-2.08c-.382-.562-1.038-1.808-1.038-1.808l3.123-5.405l-3.124-5.413z"
      />
    </svg>
  )
}

export function YandexIcon({ className }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="24"
      viewBox="0 0 13 24"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="#db0000"
        d="M5.2 24v-7.786L0 2.25h2.616L6.45 13.017L10.86-.001h2.405L7.607 16.302v7.697z"
      />
    </svg>
  )
}

export function GenericOauth2Icon({ className }: IconProps): JSX.Element {
  // The vendor-supplied icon is a stylised "O" lock — we render it via
  // currentColor so it picks up the surrounding text color tailwind class.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="128"
      height="128"
      viewBox="0 0 128 128"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M64.6 0a78 78 0 0 0-5.19.188C52.012.698 43.6 2.903 38.6 5.117c-4.012 1.773-8.565 4.44-12.321 7.115c-9.334 6.664-16.905 16.301-21.354 27.38c-.923 2.304-2.093 4.775-2.738 7.118c-2.743 9.996-2.515 21.649-.545 30.664c4.914 22.532 18.131 35.526 35.32 44.63c15.427 8.172 38.988 7.939 55.851-.55c10.083-5.077 18.136-12.813 24.365-22.176c6.057-9.112 10.704-21.527 10.677-35.865c-.023-13.2-5.3-26.044-10.677-34.497C107.124 13.12 90.013-.033 64.6 0m.31 3.072c18.993-.022 33.828 8.963 43.235 19.292c2.656 2.92 5.31 5.816 7.116 8.762c3.346 5.45 5.486 11.89 7.121 18.07c6.115 23.117-3.076 45.042-14.514 56.946c-8.545 8.897-19.037 14.915-32.854 17.521c-15.547 2.937-30.462-.889-41.069-6.844C23.05 110.7 15.331 102.006 9.581 90.81C4.037 80.014 1.457 62.841 5.474 48.645c3.61-12.754 9.772-23.344 19.439-30.935c6.703-5.262 14.41-10.146 24.914-12.867c3.772-.979 7.258-1.39 11.227-1.643a59 59 0 0 1 3.855-.128zM60.996 39.78h6.639c2.306 0 4.474 1.517 5.195 3.75l13.13 39.54c.936 2.882-.58 5.986-3.464 6.927a5.7 5.7 0 0 1-1.736.276c-2.304 0-4.44-1.432-5.192-3.74l-3.098-9.456H56.742l-2.888 9.38a5.51 5.51 0 0 1-5.231 3.807a5.6 5.6 0 0 1-1.697-.267c-2.883-.867-4.47-3.97-3.605-6.858l12.48-39.535c.72-2.237 2.813-3.824 5.195-3.824"
      />
    </svg>
  )
}

/**
 * PocketID is shipped as a raster PNG, so we inline it as a base64 data URI
 * to keep the bundle self-contained (no extra public/* asset). This is the
 * official PocketID logo (192×192, ~4.4 KB).
 */
const POCKETID_DATA_URI =
  'data:image/png;base64,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'

export function PocketIdIcon({ className }: IconProps): JSX.Element {
  return (
    <img
      src={POCKETID_DATA_URI}
      alt=""
      aria-hidden="true"
      className={className}
      width={24}
      height={24}
    />
  )
}

/**
 * Telegram has no vendor SVG in this checkout — we keep the lucide
 * `Send` icon (already used by the existing AuthProvidersTab) so we don't
 * have to ship another asset.
 */
export function TelegramIcon({ className }: IconProps): JSX.Element {
  return <Send className={className} aria-hidden="true" />
}

/**
 * Returns the icon component for a given AuthProvider type.
 */
export function getAuthProviderIcon(
  type: AuthProviderIconType,
): (props: IconProps) => JSX.Element {
  switch (type) {
    case 'GITHUB':
      return GitHubIcon
    case 'KEYCLOAK':
      return KeycloakIcon
    case 'YANDEX':
      return YandexIcon
    case 'POCKETID':
      return PocketIdIcon
    case 'GENERIC_OAUTH2':
      return GenericOauth2Icon
    case 'TELEGRAM':
    default:
      return TelegramIcon
  }
}
