/**
 * PullToRefresh Component
 * Pull-to-refresh functionality for Telegram Mini App
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { hapticFeedback } from '@/services/telegram';

/**
 * PullToRefresh props interface
 */
interface PullToRefreshProps {
  /** Children content */
  children: React.ReactNode;
  /** Refresh callback */
  onRefresh: () => Promise<void>;
  /** Pull threshold in pixels (default: 80) */
  threshold?: number;
  /** Maximum pull distance in pixels (default: 150) */
  maxPullDistance?: number;
  /** Refresh indicator content */
  indicator?: React.ReactNode;
  /** Container className */
  className?: string;
}

/**
 * Pull to refresh component
 * Provides native-like pull-to-refresh functionality
 */
export function PullToRefresh({
  children,
  onRefresh,
  threshold = 80,
  maxPullDistance = 150,
  indicator,
  className = '',
}: PullToRefreshProps): React.ReactElement {
  const [isPulling, setIsPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    // Only allow pull when at top of scroll
    if (containerRef.current && containerRef.current.scrollTop > 0) {
      return;
    }

    startYRef.current = e.touches[0].clientY;
    currentYRef.current = startYRef.current;
    setIsPulling(true);
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isPulling || !containerRef.current) return;

    // Check if we're at the top
    if (containerRef.current.scrollTop > 0) {
      setIsPulling(false);
      setPullDistance(0);
      return;
    }

    currentYRef.current = e.touches[0].clientY;
    const distance = Math.max(0, currentYRef.current - startYRef.current);

    // Apply resistance
    const resistance = 0.5;
    const dampedDistance = Math.min(distance * resistance, maxPullDistance);

    setPullDistance(dampedDistance);

    // Prevent default scrolling when pulling
    if (distance > 0 && containerRef.current.scrollTop === 0) {
      e.preventDefault();
    }
  }, [isPulling, maxPullDistance]);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling) return;

    setIsPulling(false);

    if (pullDistance >= threshold) {
      setIsRefreshing(true);
      hapticFeedback('light');

      try {
        await onRefresh();
        hapticFeedback('success');
      } catch {
        hapticFeedback('error');
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      // Snap back
      setPullDistance(0);
    }
  }, [isPulling, pullDistance, threshold, onRefresh]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progress = Math.min(pullDistance / threshold, 1);

  const defaultIndicator = (
    <div className="flex flex-col items-center justify-center py-4">
      <div
        className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full transition-transform duration-200"
        style={{
          transform: `rotate(${progress * 360}deg)`,
          opacity: progress,
        }}
      />
      <span className="text-xs text-muted-foreground mt-2">
        {isRefreshing ? 'Обновление...' : progress >= 1 ? 'Отпустите для обновления' : 'Потяните для обновления'}
      </span>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`relative overflow-y-auto ${className}`}
      style={{
        transform: isPulling || isRefreshing ? `translateY(${pullDistance}px)` : 'translateY(0)',
        transition: isPulling ? 'none' : 'transform 0.3s ease-out',
      }}
    >
      {/* Pull indicator */}
      <div
        className="absolute top-0 left-0 right-0 -translate-y-full flex items-end justify-center"
        style={{
          height: `${maxPullDistance}px`,
        }}
      >
        {indicator ?? defaultIndicator}
      </div>

      {/* Content */}
      {children}
    </div>
  );
}

export default PullToRefresh;
