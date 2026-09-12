import type { JiraClient } from './client.js';

/**
 * The only two functions in StandSync that mutate Jira.
 *
 * Call sites are restricted to src/approval/execute.ts, which runs solely after a
 * human has approved a batch. Nothing in the standup, interpretation or proposal
 * path may import this module — if grep shows another caller, the
 * AI-recommends/human-approves/StandSync-executes rule has been broken.
 */

/** Atlassian Document Format — the only comment body shape the v3 API accepts. */
export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: { type: 'paragraph'; content: { type: 'text'; text: string }[] }[];
}

export function toAdf(text: string): AdfDocument {
  return {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Marks the comment as machine-written and attributes it to the person whose
 * standup produced it, so a reader can always trace a comment back to its source.
 */
export function formatCommentText(body: string, authorName: string): string {
  return `[StandSync] ${body.trim()} — from standup by ${authorName}`;
}

export class JiraActions {
  constructor(private readonly client: JiraClient) {}

  /** Applies a transition by id. Jira answers 204 with no body on success. */
  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.client.request<void>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
      issueKey: key,
    });
  }

  /** Adds an ADF comment, prefixed and attributed. */
  async addComment(key: string, body: string, authorName: string): Promise<void> {
    await this.client.request<unknown>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: { body: toAdf(formatCommentText(body, authorName)) },
      issueKey: key,
    });
  }
}
