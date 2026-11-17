# Repository guidance

This is a synthetic trial repository. Its code redirects users after sign-in.

## Code Review Rules

### Redirect safety

- Treat as P1 any input that could make a browser navigate to a different origin (an open redirect). Safe path: accept only same-origin paths or exact allow-listed `https:` hosts. Everything else falls back to the safe default.
- Treat as P1 any function in `src/` that can throw on untrusted input.

### Scope

- Review the pull request diff only. Mechanical checks (formatting, lint) belong in CI, not in review.
