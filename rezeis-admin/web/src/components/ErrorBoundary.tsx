import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, RotateCcw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { logClientDiagnostic, reportReactError } from '@/lib/client-logger'

interface ErrorBoundaryProps {
  readonly children: ReactNode
  readonly fallback?: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * React Error Boundary that catches unhandled errors in the component tree.
 * Prevents the entire app from crashing when a single page/component fails.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Local diagnostics are development-only and redacted before printing.
    logClientDiagnostic('[ErrorBoundary] Caught error', error, errorInfo)
    // Best-effort report to backend audit (rate-limited internally).
    reportReactError(error, errorInfo.componentStack)
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return <ErrorFallback onReset={() => this.setState({ hasError: false, error: null })} />
    }
    return this.props.children
  }
}

function ErrorFallback({ onReset }: { readonly onReset: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-center min-h-[400px] p-6">
      <Alert variant="destructive" className="max-w-lg">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('errorBoundary.title')}</AlertTitle>
        <AlertDescription className="mt-2">
          <p>{t('errorBoundary.description')}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 gap-2"
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('errorBoundary.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
