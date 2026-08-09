import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const { t } = useTranslation()
  return (
    // min-h-dvh + safe-area padding, matching every other full-viewport shell
    // in the app: `100vh` is iOS's LARGE viewport (content sits low under the
    // address bar), and index.html ships `viewport-fit=cover` with a
    // black-translucent status bar (content renders under the notch).
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <h1 className="text-6xl font-bold text-muted-foreground">{t('notFoundPage.code')}</h1>
      <p className="text-xl font-semibold">{t('notFoundPage.title')}</p>
      <p className="text-muted-foreground">{t('notFoundPage.description')}</p>
      <Button asChild>
        <Link to="/">{t('notFoundPage.backToDashboard')}</Link>
      </Button>
    </div>
  )
}
