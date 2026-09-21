/**
 * Unwrap an `app.rest()` result to the downstream JSON body.
 *
 * app-react types the result as `{ statusCode, body }`, but the Hub's
 * `mcp-apps.rest-call` route returns that pair AS its HTTP response, so the
 * host bridge's `response.json()` hands the iframe the downstream body itself
 * (`{ folders: [...] }`), with no `.body` wrapper. Reading `.body` blindly then
 * yields `undefined` — lists look empty and creates look malformed. Accept both
 * shapes so the app works against either bridge behaviour.
 */
export function unwrapRestBody<T>(response: unknown): T {
  const wrapped = (response as { body?: unknown } | null | undefined)?.body;
  return (wrapped !== undefined && wrapped !== null ? wrapped : (response ?? {})) as T;
}
