import { useEffect, useRef, useState } from 'react';

/**
 * Keeps an element mounted long enough to animate itself out.
 *
 * The problem this solves is the only genuinely hard part of animating with
 * CSS: React unmounts a node the instant its condition goes false, so there is
 * nothing on the page left to run a leave animation on. Libraries solve it by
 * owning the whole render (`AnimatePresence`); this solves it by owning six
 * lines of state.
 *
 * `state` is written to a `data-state` attribute and the stylesheet keys off
 * it — `open` plays the entrance, `closing` plays the exit. The element leaves
 * the tree when the exit finishes.
 *
 * Two details that are easy to get wrong and expensive to debug:
 *
 *   · **Reopening mid-exit.** Toggling a modal quickly used to leave a stale
 *     timer that unmounted the *reopened* dialog a moment later. The timer is
 *     cleared on every change, not just on unmount.
 *
 *   · **Reduced motion.** Somebody who has asked for less movement should not
 *     wait 140ms for an invisible animation, so the exit is skipped outright
 *     and the element unmounts immediately.
 */
export function usePresence(
  open: boolean,
  leaveMs = 160,
): { mounted: boolean; state: 'open' | 'closing' } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'open' | 'closing'>(open ? 'open' : 'closing');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    if (open) {
      setMounted(true);
      /* A frame's delay so the browser paints the entrance keyframe's start
       * before the class lands. Setting both in the same tick means the
       * animation is skipped and the element simply appears. */
      const raf = requestAnimationFrame(() => setState('open'));
      return () => cancelAnimationFrame(raf);
    }

    if (!mounted) return undefined;

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      setMounted(false);
      return undefined;
    }

    setState('closing');
    timer.current = setTimeout(() => setMounted(false), leaveMs);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
    /* `mounted` is read here but is deliberately absent from the dependency
     * list: reacting to it would re-run this effect on the very state change
     * the exit itself causes, and the element would never finish leaving. */
  }, [open, leaveMs]);

  return { mounted, state };
}
