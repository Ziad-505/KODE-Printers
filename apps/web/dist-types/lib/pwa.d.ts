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
export declare const UPDATE_READY_EVENT = "kode:update-ready";
export declare function initialiseServiceWorker(): void;
/**
 * Applies a waiting update and reloads.
 *
 * The reload is the plugin's own: it waits for the new worker to take control
 * first, so the page that comes back is the new build rather than the old one
 * served from cache one last time.
 */
export declare function applyWaitingUpdate(): Promise<void>;
//# sourceMappingURL=pwa.d.ts.map