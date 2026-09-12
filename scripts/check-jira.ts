/**
 * Diagnostic: prove the Jira credentials work and show an issue's live state.
 *
 * Usage: npx tsx scripts/check-jira.ts TES-41
 */
import { getConfig } from '../src/config.js';
import { JiraClient, JiraError } from '../src/jira/client.js';
import { JiraIssues } from '../src/jira/issues.js';

async function main(): Promise<void> {
  const config = getConfig();
  const key = process.argv[2];
  if (!key) throw new Error('Usage: npx tsx scripts/check-jira.ts <ISSUE-KEY>');

  const issues = new JiraIssues(
    new JiraClient({
      baseUrl: config.JIRA_BASE_URL,
      email: config.JIRA_EMAIL,
      apiToken: config.JIRA_API_TOKEN,
    }),
  );

  const state = await issues.getIssueState(key);
  console.log(`\n${state.key} — ${state.summary}`);
  console.log(`  status:    ${state.status}`);
  console.log(`  assignee:  ${state.assignee ?? '(unassigned)'}`);
  console.log(`  transitions available:`);
  for (const t of state.transitions) {
    console.log(`    id ${t.id.padEnd(4)} "${t.name}" -> ${t.toStatus}`);
  }
  console.log();
}

main().catch((err: unknown) => {
  if (err instanceof JiraError) {
    console.error(`\nJira error (${err.status}): ${err.message}\n`);
    process.exit(1);
  }
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
