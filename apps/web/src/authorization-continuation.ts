/** The authorization server revalidates client, scopes, callback and PKCE.
 * Only navigate to the fixed OAuth path on the configured API, never a caller URL.
 */
export function authorizationContinuation(
  href: string,
  baseUrl: string,
): string | null {
  const parameters = new URL(href).searchParams.get("authorize");
  if (!parameters || parameters.length > 4096) return null;
  const target = new URL("/oauth/authorize", baseUrl);
  target.search = new URLSearchParams(parameters).toString();
  return target.toString();
}

export function resumeAuthorization(baseUrl: string) {
  const target = authorizationContinuation(window.location.href, baseUrl);
  if (target) window.location.assign(target);
}
