/**
 * Normalizes the `returnTo` value used after sign-in.
 *
 * Returns `target` when it is a same-origin path, and `'/'` for anything else, so callers can put
 * the result straight into a `Location` header. Never throws.
 *
 * @param {unknown} target
 * @returns {string}
 */
export function normalizeReturnTo(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048) return '/';
  // Absolute URLs and schemes (https:, javascript:, data:) do not start with a slash.
  if (!target.startsWith('/')) return '/';
  // Protocol-relative URLs (//host) would leave the site.
  if (target.startsWith('//')) return '/';
  return target;
}
