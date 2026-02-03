/**
 * Checkbox Component
 * Simple accessible checkbox with custom styling
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Checkbox component props
 */
interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Checked state */
  checked?: boolean;
  /** Default checked state for uncontrolled mode */
  defaultChecked?: boolean;
}

/**
 * Checkbox Component
 * Simple checkbox with custom styling
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, defaultChecked, onChange, ...props }, ref) => {
    const [isChecked, setIsChecked] = React.useState(defaultChecked ?? checked ?? false);

    React.useEffect(() => {
      if (checked !== undefined) {
        setIsChecked(checked);
      }
    }, [checked]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setIsChecked(e.target.checked);
      onChange?.(e);
    };

    return (
      <input
        type="checkbox"
        ref={ref}
        checked={isChecked}
        onChange={handleChange}
        className={cn(
          'size-4 rounded border border-primary cursor-pointer transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
          isChecked && 'bg-primary text-primary-foreground',
          className
        )}
        {...props}
      />
    );
  }
);
Checkbox.displayName = 'Checkbox';
