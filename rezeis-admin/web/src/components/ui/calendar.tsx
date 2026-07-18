import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker } from 'react-day-picker'

import { cn } from '@/lib/utils'

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      components={{
        // Render explicit lucide chevrons so the month-nav arrows are always
        // visible and correctly coloured (the default chevron rendered blank
        // against an opaque button background).
        Chevron: ({ orientation, className: chevronClassName }) =>
          orientation === 'left' ? (
            <ChevronLeft className={cn('h-4 w-4', chevronClassName)} />
          ) : (
            <ChevronRight className={cn('h-4 w-4', chevronClassName)} />
          ),
      }}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-2',
        month: 'relative flex min-h-[18rem] flex-col gap-4',
        month_caption: 'flex h-8 w-full items-center justify-center',
        caption_label: 'text-sm font-medium',
        nav: 'absolute inset-x-0 top-0 flex h-8 items-center justify-between px-1',
        button_previous:
          'inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-transparent p-0 text-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30',
        button_next:
          'inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-transparent p-0 text-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30',
        month_grid: 'w-full border-collapse space-x-1',
        weekdays: 'flex',
        weekday:
          'text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-accent [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50',
        day_button: cn(
          'inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-8 p-0 font-normal aria-selected:opacity-100',
        ),
        range_end: 'day-range-end rounded-r-md',
        selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md',
        today: 'bg-accent text-accent-foreground rounded-md',
        outside:
          'day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30',
        disabled: 'text-muted-foreground opacity-50',
        range_middle:
          'aria-selected:bg-accent aria-selected:text-accent-foreground',
        hidden: 'invisible',
        ...classNames,
      }}
      {...props}
    />
  )
}

export { Calendar }
