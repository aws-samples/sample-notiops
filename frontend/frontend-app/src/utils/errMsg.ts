/**
 * Extract a safe, human-readable message from an unknown thrown value.
 *
 * Logging a raw error object can leak sensitive context (response bodies,
 * request payloads, stack frames with embedded data) to the browser console.
 * Per the sensitive-data-handling guidance we log only the message
 * string, never the full object.
 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "unknown error";
}
