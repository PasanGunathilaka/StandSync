import { z } from 'zod';
import type { JiraIssueState } from '../types.js';
import { JiraError, JiraNotFoundError, type JiraClient } from './client.js';

/** Jira responses are external input, so every shape is validated before use. */

const IssueResponse = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    status: z.object({ name: z.string() }).nullish(),
    assignee: z.object({ displayName: z.string().nullish() }).nullish(),
  }),
});

const TransitionsResponse = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: z.object({ name: z.string() }).nullish(),
    }),
  ),
});

const SearchResponse = z.object({
  issues: z.array(IssueResponse).default([]),
});

/** Outcome of looking a key up: either live state, or why we could not get it. */
export type IssueLookup =
  | { key: string; found: true; state: JiraIssueState }
  | { key: string; found: false; reason: string };

export class JiraIssues {
  constructor(private readonly client: JiraClient) {}

  async getIssue(key: string): Promise<z.infer<typeof IssueResponse>> {
    const raw = await this.client.request<unknown>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee`,
      { issueKey: key },
    );
    return IssueResponse.parse(raw);
  }

  async getTransitions(key: string): Promise<JiraIssueState['transitions']> {
    const raw = await this.client.request<unknown>(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { issueKey: key },
    );
    return TransitionsResponse.parse(raw).transitions.map((t) => ({
      id: t.id,
      name: t.name,
      toStatus: t.to?.name ?? t.name,
    }));
  }

  /** Full live state for one issue: what it is now, and where it can legally go. */
  async getIssueState(key: string): Promise<JiraIssueState> {
    const [issue, transitions] = await Promise.all([this.getIssue(key), this.getTransitions(key)]);
    const assignee = issue.fields.assignee?.displayName;
    return {
      key: issue.key,
      summary: issue.fields.summary ?? '',
      status: issue.fields.status?.name ?? 'Unknown',
      ...(assignee ? { assignee } : {}),
      transitions,
    };
  }

  /**
   * Looks up many keys at once. A missing or unreadable ticket must not sink the
   * whole standup, so failures come back as `found: false` rather than throwing.
   */
  async getIssueStates(keys: string[]): Promise<IssueLookup[]> {
    const settled = await Promise.allSettled(keys.map((k) => this.getIssueState(k)));

    return settled.map((result, i): IssueLookup => {
      const key = keys[i] ?? '';
      if (result.status === 'fulfilled') return { key, found: true, state: result.value };

      const err: unknown = result.reason;
      if (err instanceof JiraNotFoundError) return { key, found: false, reason: 'not found' };
      if (err instanceof JiraError) return { key, found: false, reason: err.message };
      return {
        key,
        found: false,
        reason: err instanceof Error ? err.message : 'unknown Jira error',
      };
    });
  }

  /**
   * Stale-ticket support (optional feature): issues assigned to someone in this
   * project that have not been updated in `days` days and are not already done.
   */
  async searchAssignedNotUpdated(
    projectKey: string,
    days: number,
  ): Promise<{ key: string; summary: string; status: string; assignee?: string }[]> {
    const jql =
      `project = "${projectKey}" AND assignee IS NOT EMPTY ` +
      `AND statusCategory != Done AND updated <= -${days}d ORDER BY updated ASC`;

    const raw = await this.client.request<unknown>('/rest/api/3/search/jql', {
      method: 'POST',
      body: { jql, fields: ['summary', 'status', 'assignee'], maxResults: 50 },
    });

    return SearchResponse.parse(raw).issues.map((issue) => {
      const assignee = issue.fields.assignee?.displayName;
      return {
        key: issue.key,
        summary: issue.fields.summary ?? '',
        status: issue.fields.status?.name ?? 'Unknown',
        ...(assignee ? { assignee } : {}),
      };
    });
  }
}
