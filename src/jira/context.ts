import { z } from 'zod';
import { logger, type Logger } from '../logger.js';
import { JiraError, JiraNotFoundError, type JiraClient } from './client.js';
import type { JiraIssues, IssueLookup } from './issues.js';

/**
 * Deterministic Jira context gathering.
 *
 * This is application code that reads Jira and hands the reasoning agents a
 * sanitized, typed snapshot. It is emphatically NOT an agent with Jira
 * credentials:
 *
 *     Jira API -> JiraContextService -> sanitized IssueContext -> Claude
 *
 * never
 *
 *     Claude -> Jira credential -> arbitrary Jira API
 *
 * Two properties matter. First, the shape handed to a model is fixed, so a
 * prompt injection in a Jira summary cannot widen what the model can see.
 * Second, transition *ids* are read here but never included in what a model
 * receives — src/jira/statusMap.ts resolves ids from live state at proposal
 * time, so a model can neither name nor influence the transition applied.
 */

/** Fields the context service asks Jira for. Deliberately short. */
const CONTEXT_FIELDS = 'summary,status,issuetype,assignee,reporter,resolution';

const ContextResponse = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    status: z.object({ name: z.string() }).nullish(),
    issuetype: z.object({ name: z.string() }).nullish(),
    assignee: z.object({ displayName: z.string().nullish() }).nullish(),
    reporter: z.object({ displayName: z.string().nullish() }).nullish(),
    resolution: z.object({ name: z.string() }).nullish(),
  }),
});

/**
 * What a reasoning agent is allowed to know about an issue.
 *
 * Note what is absent: transition ids, raw Jira JSON, URLs, account ids, custom
 * fields, comment bodies. Status names and the *names* of reachable statuses are
 * enough for a model to notice "they said done but the next step is Code
 * Review"; anything more is capability without purpose.
 */
export interface IssueContext {
  key: string;
  exists: true;
  summary: string;
  status: string;
  issueType: string;
  assignee?: string;
  reporter?: string;
  resolution?: string;
  /** Destination status names reachable from the current status, right now. */
  availableTransitions: string[];
}

export interface MissingIssueContext {
  key: string;
  exists: false;
  reason: string;
}

export type IssueContextResult = IssueContext | MissingIssueContext;

export interface JiraContextServiceOptions {
  client: JiraClient;
  issues: JiraIssues;
  log?: Logger;
}

/** Truncates free text from Jira before it reaches a prompt. */
function sanitize(value: string | null | undefined, max = 200): string {
  if (!value) return '';
  // Collapse newlines: a multi-line Jira summary should not be able to forge
  // extra lines in the structured context block of a prompt.
  const flat = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class JiraContextService {
  private readonly client: JiraClient;
  private readonly issues: JiraIssues;
  private readonly log: Logger;

  constructor(opts: JiraContextServiceOptions) {
    this.client = opts.client;
    this.issues = opts.issues;
    this.log = opts.log ?? logger;
  }

  /**
   * Gathers everything StandSync knows about one issue, in both views, from a
   * single pair of Jira reads. A failure is reported, never invented: if Jira
   * cannot be read, both views say so and downstream stages must treat the issue
   * as unknown rather than assume anything about it.
   */
  async gather(key: string): Promise<IssueContextBundle> {
    try {
      const [raw, transitions] = await Promise.all([
        this.client.request<unknown>(
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${CONTEXT_FIELDS}`,
          { issueKey: key },
        ),
        this.issues.getTransitions(key),
      ]);

      const issue = ContextResponse.parse(raw);
      const assignee = sanitize(issue.fields.assignee?.displayName, 80);
      const reporter = sanitize(issue.fields.reporter?.displayName, 80);
      const resolution = sanitize(issue.fields.resolution?.name, 60);
      const summary = sanitize(issue.fields.summary);
      const status = sanitize(issue.fields.status?.name, 60) || 'Unknown';

      const context: IssueContext = {
        key: issue.key,
        exists: true,
        summary,
        status,
        issueType: sanitize(issue.fields.issuetype?.name, 60) || 'Unknown',
        ...(assignee ? { assignee } : {}),
        ...(reporter ? { reporter } : {}),
        ...(resolution ? { resolution } : {}),
        // Destination names only. Ids stay in the lookup below, which never
        // reaches a prompt.
        availableTransitions: [...new Set(transitions.map((t) => sanitize(t.toStatus, 60)))].filter(
          Boolean,
        ),
      };

      const lookup: IssueLookup = {
        key: issue.key,
        found: true,
        state: {
          key: issue.key,
          summary,
          status,
          ...(assignee ? { assignee } : {}),
          transitions,
        },
      };

      return { key, context, lookup };
    } catch (err) {
      const reason = describeLookupFailure(err);
      return {
        key,
        context: { key, exists: false, reason },
        lookup: { key, found: false, reason },
      };
    }
  }

  /**
   * Gathers context for many issues at once. One unreadable ticket must not sink
   * a whole standup, so each key settles independently.
   */
  async gatherAll(keys: string[]): Promise<IssueContextBundle[]> {
    if (keys.length === 0) return [];

    const bundles = await Promise.all(keys.map((key) => this.gather(key)));

    this.log.debug(
      {
        scope: 'jira-context',
        resolved: bundles.map((b) => `${b.key}:${b.context.exists ? b.context.status : 'missing'}`),
      },
      'Jira context gathered',
    );

    return bundles;
  }
}

/**
 * Both views of one issue, from one read.
 *
 * `context` is prompt-safe and goes to reasoning agents. `lookup` carries
 * transition ids and stays inside StandSync, feeding src/jira/statusMap.ts and
 * src/standup/propose.ts. Producing them together is what guarantees the model
 * and the proposal builder reason about the same snapshot of Jira.
 */
export interface IssueContextBundle {
  key: string;
  context: IssueContextResult;
  lookup: IssueLookup;
}

/** The prompt-safe views only, in the order the keys were given. */
export function contextsOf(bundles: IssueContextBundle[]): IssueContextResult[] {
  return bundles.map((b) => b.context);
}

/** The StandSync-internal views only, in the order the keys were given. */
export function lookupsOf(bundles: IssueContextBundle[]): IssueLookup[] {
  return bundles.map((b) => b.lookup);
}

function describeLookupFailure(err: unknown): string {
  if (err instanceof JiraNotFoundError) return 'not found';
  if (err instanceof JiraError) return err.message;
  if (err instanceof Error) return err.message;
  return 'unknown Jira error';
}

/** Narrowing helper, since `exists` is the discriminant callers branch on. */
export function isPresent(context: IssueContextResult | undefined): context is IssueContext {
  return context?.exists === true;
}

/**
 * Renders one issue's context as a prompt line.
 *
 * Kept here rather than in the skill so every prompt describes Jira the same
 * way, and so the decision about what a model may see lives next to the decision
 * about what is fetched.
 */
export function describeContextForPrompt(
  key: string,
  context: IssueContextResult | undefined,
): string {
  if (!context) return `- ${key}: current Jira state unknown`;
  if (!context.exists) return `- ${key}: NOT FOUND in Jira (${context.reason})`;

  const parts = [
    `currently "${context.status}"`,
    `type ${context.issueType}`,
    context.assignee ? `assigned to ${context.assignee}` : 'unassigned',
  ];
  if (context.resolution) parts.push(`resolution ${context.resolution}`);
  if (context.availableTransitions.length) {
    parts.push(`can move to: ${context.availableTransitions.join(', ')}`);
  } else {
    parts.push('no transitions currently available');
  }

  return `- ${key}: ${parts.join('; ')} — ${context.summary}`;
}
