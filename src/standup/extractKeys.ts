/**
 * Jira issue key detection.
 *
 * A key is PROJECT-NUMBER where PROJECT starts with a letter and is at least two
 * characters (Jira's own rule). Matching is case-sensitive on purpose: real keys
 * are uppercase, and accepting lowercase would turn ordinary prose like
 * "the api-2 spec" into a ticket lookup.
 */

// Guard the left edge so "XPAY-142" and "v2-3" do not match, and the right edge
// so "PAY-1423" is never truncated to "PAY-142".
const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])/g;

/**
 * Returns every distinct Jira key in the message, in first-seen order.
 * Order matters: the proposal card lists tickets in the order the author
 * mentioned them, which is how they expect to read it back.
 */
export function extractKeys(text: string): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const keys: string[] = [];

  for (const match of text.matchAll(KEY_PATTERN)) {
    const key = match[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

/** Narrows to keys belonging to one project, e.g. only PAY-* tickets. */
export function filterByProject(keys: string[], projectKey: string): string[] {
  const prefix = `${projectKey.toUpperCase()}-`;
  return keys.filter((k) => k.startsWith(prefix));
}
