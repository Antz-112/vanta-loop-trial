# isSafeRedirect

Create `src/is-safe-redirect.js` exporting:

```js
export function isSafeRedirect(target, { allowedHosts = [] } = {}) // → boolean
```

It decides whether `target`, a value taken from a query parameter such as `?next=`, is safe to put in a `Location` header.

Return `true` only when one of these holds:

1. `target` is a same-origin path:
   - it starts with exactly one `/`;
   - its second character is not `/` or `\`;
   - it contains no backslash anywhere;
   - it contains no ASCII control characters (U+0000–U+001F, U+007F) and no whitespace.
2. `target` is an absolute `https:` URL whose hostname is exactly one of `allowedHosts`:
   - the comparison ignores case;
   - the URL has no username or password;
   - the URL has no explicit port.

Return `false` for everything else, including:
- non-strings and the empty string;
- protocol-relative URLs (`//host`);
- other schemes (`http:`, `javascript:`, `data:`);
- lookalike hosts (`app.example.evil.example`);
- anything longer than 2048 characters.

The function must never throw.
