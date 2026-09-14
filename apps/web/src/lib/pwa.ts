import { registerSW } from 'virtual:pwa-register';

/**
 * Service-worker registration.
 *
 * The build has always produced a service worker — `vite-plugin-pwa` writes
 * `sw.js` on every `npm run build` — and nothing ever registered it. The
 * consequences were quiet and compounding: the app could not be installed to a
 * home screen, it never worked offline, and `navigator.serviceWorker.ready` in
 * the account screen never resolved, so turning on push notifications hung
 * forever with no error. A generated file nobody loads is not a PWA.
 *
 * `registerType: 'prompt'` in the Vite config means an update is *offered*
 * rather than applied under someone's hands. That is the right choice for this
 * app — reloading the page while a print job is being composed would lose the
 * file they picked — but it only works if something actually shows the offer,
 * which is what `onNeedRefresh` is for.
 */

/** Fired when a new build is waiting. `App` listens and shows the offer. */
export const UPDATE_READY_EVENT = 'kode:update-ready';

let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function initialiseServiceWorker(): void {
  // Nothing to register in `npm run dev` — the plugin's dev service worker is
  // off, and registering a stale one against the Vite dev server causes far
  // stranger problems than not having one.
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;

  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT));
    },
    onRegisterError(error: unknown) {
      // Registration failing is survivable — the app runs online exactly as
      // before — so it is logged rather than surfaced.
      console.warn('service worker did not register', error);
    },
  });
}

/**
 * Applies a waiting update and reloads.
 *
 * The reload is the plugin's own: it waits for the new worker to take control
 * first, so the page that comes back is the new build rather than the old one
 * served from cache one last time.
 */
export async function applyWaitingUpdate(): Promise<void> {
  if (!applyUpdate) {
    window.location.reload();
    return;
  }
  await applyUpdate(true);
}
