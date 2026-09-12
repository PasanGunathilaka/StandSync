/**
 * Posts the demo standup to a running StandSync and prints the proposal batch.
 *
 * This is the Teams-free demo path: it exercises the same pipeline the Teams
 * message handler uses. Nothing is written to Jira — the batch waits for an
 * explicit approval call, which the script prints for you.
 *
 * Usage:
 *   npm run dev            # in one terminal
 *   npm run dev:post       # in another
 *   npm run dev:post -- "I mostly finished TES-41 but QA found a bug, don't close it"
 */
import { readFileSync, existsSync } from 'node:fs';
import { getConfig } from '../src/config.js';

const DEMO_TICKETS_PATH = './data/demo-tickets.json';

function demoMessage(): string {
  if (!existsSync(DEMO_TICKETS_PATH)) {
    throw new Error(
      `${DEMO_TICKETS_PATH} not found. Run "npm run seed:jira" first so the demo ` +
        `uses the keys Jira actually assigned.`,
    );
  }
  const demo = JSON.parse(readFileSync(DEMO_TICKETS_PATH, 'utf8')) as {
    tickets: { key: string }[];
  };
  const [a, b, c] = demo.tickets.map((t) => t.key);
  return (
    `Yesterday I completed ${a}. Today I am working on ${b}. ` +
    `${c} is blocked because I am waiting for API credentials.`
  );
}

interface StandupResponse {
  batch: { id: string; proposals: unknown[] } | null;
  message?: string;
  summary?: {
    title: string;
    rows: {
      key: string;
      action: string;
      confidence: number;
      selected: boolean;
      explanation: string;
    }[];
    actions: string[];
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  // 127.0.0.1, not localhost: Node fetch prefers IPv6 (::1) while the server
  // binds IPv4 0.0.0.0, which makes localhost fail where curl quietly falls back.
  const base = `http://127.0.0.1:${config.PORT}`;
  const text = process.argv.slice(2).join(' ').trim() || demoMessage();

  console.log(`\nPosting to ${base}/dev/standup\n`);
  console.log(`  "${text}"\n`);

  let res: Response;
  try {
    res = await fetch(`${base}/dev/standup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author: 'Pasan', authorId: 'pasan' }),
    });
  } catch (cause) {
    throw new Error(`Could not reach StandSync at ${base}. Is "npm run dev" running?`, { cause });
  }

  if (!res.ok) throw new Error(`StandSync returned ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as StandupResponse;
  if (!body.batch || !body.summary) {
    console.log(body.message ?? 'No proposals produced.');
    return;
  }

  const line = '='.repeat(74);
  console.log(line);
  console.log(body.summary.title);
  console.log(line);
  for (const row of body.summary.rows) {
    const flag = row.selected ? ' ' : '!';
    console.log(`\n ${flag} ${row.key.padEnd(10)} ${row.action}`);
    console.log(`    confidence: ${row.confidence}${row.selected ? '' : '  (unselected)'}`);
    console.log(`    ${row.explanation}`);
  }
  console.log(`\n${line}`);
  console.log(`[${body.summary.actions.join(']  [')}]`);
  console.log(line);

  console.log(`\nNothing has been written to Jira yet. To approve:\n`);
  console.log(`  curl -X POST ${base}/dev/approve/${body.batch.id}\n`);
  console.log(`To reject instead:\n`);
  console.log(`  curl -X POST ${base}/dev/reject/${body.batch.id}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
