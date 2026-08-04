import type { ReactNode } from 'react'

import type { LandingKitLinkProps } from '../live/landing-kit-context'

/**
 * CTA link for the builder preview: looks exactly like the live one, but does
 * not navigate. The preview is an editing surface — following `/register`
 * would replace the operator's canvas with a broken route inside the iframe.
 * Kept a real anchor so the href stays inspectable and styling is identical.
 */
export function PreviewLink({ to, className, children }: LandingKitLinkProps): ReactNode {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => event.preventDefault()}
      data-preview-link=""
    >
      {children}
    </a>
  )
}
