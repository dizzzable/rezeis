import { format } from 'date-fns'
import { CalendarIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface DatePickerProps {
  readonly value: Date | undefined
  readonly onChange: (date: Date | undefined) => void
  readonly placeholder?: string
  readonly className?: string
  readonly disabled?: boolean
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  className,
  disabled,
}: DatePickerProps) {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'h-9 w-full justify-start text-left font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? format(value, 'dd.MM.yyyy') : (placeholder ?? t('common.pickDate'))}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
        />
      </PopoverContent>
    </Popover>
  )
}
