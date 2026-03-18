import { useEffect, useRef, useState } from 'preact/hooks';
import { isMobile } from '../state/store';

const THRESHOLD = 80;
const MAX_PULL = 120;

export function PullToRefresh() {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pulling = useRef(false);

  useEffect(() => {
    if (!isMobile.value) return;

    const isAtTop = () => window.scrollY <= 0;

    const isInScrollable = (target: EventTarget | null): boolean => {
      let el = target as HTMLElement | null;
      while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollTop > 0) return true;
        el = el.parentElement;
      }
      return false;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return;
      if (!isAtTop() || isInScrollable(e.target)) return;
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!startY.current || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;

      if (dy > 10 && isAtTop() && !isInScrollable(e.target)) {
        pulling.current = true;
        e.preventDefault();
        setPullDistance(Math.min(dy * 0.5, MAX_PULL));
      }
    };

    const onTouchEnd = () => {
      if (pulling.current && pullDistance >= THRESHOLD) {
        setRefreshing(true);
        setPullDistance(THRESHOLD);
        setTimeout(() => location.reload(), 300);
      } else {
        setPullDistance(0);
      }
      startY.current = 0;
      pulling.current = false;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [pullDistance, refreshing]);

  if (!isMobile.value || (pullDistance === 0 && !refreshing)) return null;

  const progress = Math.min(pullDistance / THRESHOLD, 1);

  return (
    <div
      class="pull-to-refresh"
      style={{ transform: `translateY(${pullDistance - 40}px)`, opacity: progress }}
    >
      <div
        class="pull-to-refresh-icon"
        style={refreshing ? undefined : { transform: `rotate(${progress * 360}deg)` }}
      >
        {refreshing ? (
          <span class="loading" />
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        )}
      </div>
    </div>
  );
}
