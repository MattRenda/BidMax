// Lightweight analytics seam. Instrument the app via track(); swap the body for
// PostHog / Amplitude / Firebase later without changing any call sites.
export function track(event: string, props?: Record<string, any>): void {
  if (__DEV__) console.log('[track]', event, props ?? {});
  // TODO: forward to the chosen analytics provider.
}
