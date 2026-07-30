// Upstream coding-agent authentication failures that require the user to sign
// in again. This stays deliberately narrower than a generic "unauthorized"
// match: computeStatus only calls it for genuine API-error transcript turns,
// and these phrases identify an expired/rejected provider session rather than
// a model-access or billing failure.
export function isProviderAuthError(text: string): boolean {
  return (
    /\bfailed to authenticate\b/i.test(text) ||
    /\boauth (?:session|token) (?:has )?expired\b/i.test(text) ||
    /\bauthentication (?:session|token) (?:has )?expired\b/i.test(text) ||
    /\b(?:login|sign[- ]?in) (?:session )?(?:has )?expired\b/i.test(text) ||
    /\b(?:invalid|expired) (?:oauth |access |refresh )?token\b/i.test(text)
  );
}
