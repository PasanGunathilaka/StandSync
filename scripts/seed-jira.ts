/**
 * Creates or resets the three demo tickets used by the StandSync demo.
 *
 * This script never creates a Jira project — it uses the existing project named by
 * JIRA_PROJECT_KEY and fails with a clear message if that project is not reachable.
 *
 * Jira assigns issue numbers itself, so the demo tickets will not literally be
 * PAY-142/153/166 unless your project happens to be at that number. The keys Jira
 * actually assigns are written to data/demo-tickets.json and printed at the end;
 * scripts/dev-post.ts reads that file so the demo stays in sync.
 *
 * Demo tickets are tagged with the `standsync-demo` label so re-running this script
 * resets the same three issues instead of creating new ones every time.
 *
 * Usage: npm run seed:jira
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getConfig } from '../src/config.js';
import { JiraClient, JiraError, JiraNotFoundError } from '../src/jira/client.js';
import { JiraIssues } from '../src/jira/issues.js';

const DEMO_LABEL = 'standsync-demo';
const OUTPUT_PATH = './data/demo-tickets.json';

/** The three demo tickets, in the order the example standup mentions them. */
const DEMO_TICKETS = [
  { slug: 'completed', summary: 'Payment retry handling', targetStatusKey: 'IN_PROGRESS' },
  { slug: 'started', summary: 'Refund reconciliation report', targetStatusKey: 'TODO' },
  {
    slug: 'blocked',
    summary: 'Third-party payment gateway integration',
    targetStatusKey: 'IN_PROGRESS',
  },
] as const;

const CreatedIssue = z.object({ key: z.string() });
const IssueTypes = z.object({
  issueTypes: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean() })),
});
const SearchResult = z.object({
  issues: z.array(
    z.object({ key: z.string(), fields: z.object({ summary: z.string().nullish() }) }),
  ),
});

async function main(): Promise<void> {
  const config = getConfig();
  const client = new JiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });
  const issues = new JiraIssues(client);
  const project = config.JIRA_PROJECT_KEY;

  const targetStatus: Record<string, string> = {
    DONE: config.STATUS_DONE,
    IN_PROGRESS: config.STATUS_IN_PROGRESS,
    TODO: config.STATUS_TODO,
  };

  console.log(`\nStandSync demo seed — project ${project} at ${config.JIRA_BASE_URL}\n`);

  // 1. Confirm the project exists before touching anything.
  try {
    await client.request(`/rest/api/3/project/${encodeURIComponent(project)}`);
    console.log(`  project ${project} found`);
  } catch (err) {
    if (err instanceof JiraNotFoundError) {
      throw new Error(
        `Project "${project}" was not found. Set JIRA_PROJECT_KEY in .env to a project ` +
          `you can already see in Jira — this script does not create projects.`,
        { cause: err },
      );
    }
    throw err;
  }

  // 2. Pick an issue type this project actually supports.
  const meta = IssueTypes.parse(
    await client.request(`/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`),
  );
  const usable = meta.issueTypes.filter((t) => !t.subtask);
  const issueType =
    usable.find((t) => t.name === 'Task') ?? usable.find((t) => t.name === 'Story') ?? usable[0];
  if (!issueType) throw new Error(`Project ${project} exposes no usable (non-subtask) issue type.`);
  console.log(`  using issue type "${issueType.name}"`);

  // 3. Find demo tickets already created by a previous run.
  const existing = SearchResult.parse(
    await client.request('/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql: `project = "${project}" AND labels = "${DEMO_LABEL}" ORDER BY created ASC`,
        fields: ['summary'],
        maxResults: 50,
      },
    }),
  );
  const bySummary = new Map(existing.issues.map((i) => [i.fields.summary ?? '', i.key]));

  // 4. Create anything missing, then drive every ticket to its demo status.
  const seeded: { slug: string; key: string; summary: string; status: string }[] = [];

  for (const ticket of DEMO_TICKETS) {
    let key = bySummary.get(ticket.summary);

    if (key) {
      console.log(`  reusing ${key} — ${ticket.summary}`);
    } else {
      const created = CreatedIssue.parse(
        await client.request('/rest/api/3/issue', {
          method: 'POST',
          body: {
            fields: {
              project: { key: project },
              summary: ticket.summary,
              issuetype: { id: issueType.id },
              labels: [DEMO_LABEL],
            },
          },
        }),
      );
      key = created.key;
      console.log(`  created ${key} — ${ticket.summary}`);
    }

    const wanted = targetStatus[ticket.targetStatusKey] ?? config.STATUS_TODO;
    const status = await driveToStatus(client, issues, key, wanted);
    seeded.push({ slug: ticket.slug, key, summary: ticket.summary, status });
  }

  // 5. Record the real keys so the demo scripts and README stay accurate.
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify({ project, tickets: seeded }, null, 2)}\n`);

  console.log(`\nDemo tickets ready (written to ${OUTPUT_PATH}):\n`);
  for (const t of seeded) console.log(`  ${t.key.padEnd(12)} ${t.status.padEnd(14)} ${t.summary}`);

  const [completed, started, blocked] = seeded;
  console.log(`\nPost this in the channel (or run: npm run dev:post):\n`);
  console.log(
    `  "Yesterday I completed ${completed?.key}. Today I am working on ${started?.key}. ` +
      `${blocked?.key} is blocked because I am waiting for API credentials."\n`,
  );
}

/**
 * Moves an issue to `wanted` using whatever transition the live workflow offers.
 * Returns the status actually reached — some workflows cannot reach a status in
 * one hop, and the demo should report the truth rather than assume success.
 */
async function driveToStatus(
  client: JiraClient,
  issues: JiraIssues,
  key: string,
  wanted: string,
): Promise<string> {
  const state = await issues.getIssueState(key);
  if (state.status.toLowerCase() === wanted.toLowerCase()) return state.status;

  const match = state.transitions.find((t) => t.toStatus.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    console.warn(
      `    ! ${key} is "${state.status}" and has no direct transition to "${wanted}" ` +
        `(available: ${state.transitions.map((t) => t.toStatus).join(', ') || 'none'})`,
    );
    return state.status;
  }

  await client.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: { transition: { id: match.id } },
    issueKey: key,
  });
  console.log(`    ${key}: ${state.status} -> ${wanted}`);
  return wanted;
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.name === 'ConfigError') {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof JiraError) {
    console.error(`\nJira error (${err.status}): ${err.message}\n`);
    process.exit(1);
  }
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
