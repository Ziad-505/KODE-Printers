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
export declare function usePresence(open: boolean, leaveMs?: number): {
    mounted: boolean;
    state: 'open' | 'closing';
};
//# sourceMappingURL=presence.d.ts.map