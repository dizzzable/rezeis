import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-6xl font-bold text-muted-foreground">{t('notFoundPage.code')}</h1>
      <p className="text-xl font-semibold">{t('notFoundPage.title')}</p>
      <p className="text-muted-foreground">{t('notFoundPage.description')}</p>
      <Button asChild>
        <Link to="/">{t('notFoundPage.backToDashboard')}</Link>
      </Button>
    </div>
  )
}
