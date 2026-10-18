/** Lets non-React code (the API client) navigate through the router. */
// Router navigate function registered by NavigationBridge.
type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;

let navigator_: NavigateFn | null = null;

// Called by NavigationBridge with the router's navigate function.
export function setNavigator(fn: NavigateFn | null): void {
  navigator_ = fn;
}

// In-app navigation; falls back to a full page load before the router is ready.
export function navigateTo(to: string, opts?: { replace?: boolean }): void {
  if (navigator_) navigator_(to, opts);
  else window.location.assign(to);
}

/** Full-page navigation away from the app (e.g. to Google's sign-in). A function so tests can mock it. */
export function externalRedirect(url: string): void {
  window.location.assign(url);
}

// Pages reachable without a full session.
export const PUBLIC_PATHS = [/^\/login(\/|$)/, /^\/invite\//, /^\/enroll(\/|$)/];

// True when the path is one of the public pages.
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}

/** Only allow same-app relative return paths. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (isPublicPath(next)) return '/';
  return next;
}

// Builds /login?next=...&reason=... for the current location.
export function loginPathFor(current: { pathname: string; search: string }, reason?: string): string {
  const sp = new URLSearchParams();
  const ret = current.pathname + current.search;
  if (!isPublicPath(current.pathname) && ret !== '/') sp.set('next', ret);
  if (reason) sp.set('reason', reason);
  const qs = sp.toString();
  return qs ? `/login?${qs}` : '/login';
}
