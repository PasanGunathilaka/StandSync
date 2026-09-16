/**
 * One command to bring up the whole Teams demo: `npm run demo`.
 *
 * The local Teams path has six moving parts (port, tunnel host, bot endpoint,
 * Claude CLI, Jira, Teams config) and each one fails silently in its own way.
 * This script checks every one *before* starting anything, owns both long-running
 * processes, verifies the public chain end to end, and tears everything down
 * together on Ctrl+C so nothing is left holding port 3978.
 *
 * It deliberately starts nothing until every check passes: a demo that half
 * starts is worse than one that refuses to.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkConfig,
  checkJira,
  checkTeams,
  checkTunnelDefinition,
  fail,
  ok,
  portResponds,
  report,
  resolveClaude,
  warn,
  whoHasPort,
  type CheckResult,
} from './lib/preflight.js';

const TUNNEL_ID = process.env['DEVTUNNEL_ID'] ?? 'standsync';
const children: ChildProcess[] = [];
let shuttingDown = false;

function line(char = '─'): void {
  console.log(char.repeat(72));
}

/** Kills a process and everything it spawned; a bare kill leaves grandchildren. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

function shutdown(reason: string, code = 0): never | void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason} — stopping StandSync and the dev tunnel…`);
  for (const child of children) killTree(child.pid);
  // Give taskkill a moment to release the port before the process exits.
  setTimeout(() => process.exit(code), 600);
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  timed out waiting for ${what}`);
  return false;
}

async function main(): Promise<void> {
  line('═');
  console.log('StandSync — Teams demo environment');
  line('═');

  // ---- 1. Checks, before anything starts ----------------------------------
  console.log('\n[1/5] Preflight');
  const results: CheckResult[] = [];

  const { result: configResult, config } = checkConfig();
  results.push(configResult);
  if (!config) {
    report(results);
    console.log('\nCannot continue without valid configuration.\n');
    process.exit(1);
  }

  const { result: claudeResult, path: claudePath } = await resolveClaude(config.CLAUDE_CODE_PATH);
  results.push(claudeResult);

  const [jiraResult, teamsResult] = await Promise.all([checkJira(config), checkTeams(config)]);
  results.push(jiraResult, teamsResult);

  const { result: tunnelResult } = await checkTunnelDefinition(TUNNEL_ID);
  results.push(tunnelResult);

  // The port must be free, or held by a stale StandSync we are allowed to clear.
  const owner = whoHasPort(config.PORT);
  if (!owner) {
    results.push(ok('port', `${config.PORT} is free`));
  } else if (owner.isStandSync) {
    results.push(
      warn('port', `${config.PORT} held by a stale StandSync (PID ${owner.pid}) — will be stopped`),
    );
  } else {
    results.push(
      fail(
        'port',
        `${config.PORT} is held by PID ${owner.pid}, which is not StandSync`,
        'Stop that process yourself, or set PORT in .env. StandSync will not kill unknown processes.',
      ),
    );
  }

  console.log();
  if (!report(results)) {
    console.log('\nPreflight failed. Nothing was started.\n');
    process.exit(1);
  }

  // ---- 2. Clear our own stale process -------------------------------------
  if (owner?.isStandSync) {
    console.log(`\n[2/5] Clearing stale StandSync (PID ${owner.pid})`);
    killTree(owner.pid);
    await new Promise((r) => setTimeout(r, 1200));
    if (whoHasPort(config.PORT)) {
      console.log(`  port ${config.PORT} is still held — stop it manually and retry.\n`);
      process.exit(1);
    }
    console.log(`  port ${config.PORT} released`);
  } else {
    console.log('\n[2/5] No stale process to clear');
  }

  process.on('SIGINT', () => shutdown('Interrupted'));
  process.on('SIGTERM', () => shutdown('Terminated'));

  // ---- 3. Dev tunnel -------------------------------------------------------
  console.log('\n[3/5] Dev tunnel');
  const tunnel = spawn('devtunnel', ['host', TUNNEL_ID], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(tunnel);

  let publicUrl = '';
  tunnel.stdout.setEncoding('utf8');
  tunnel.stdout.on('data', (chunk: string) => {
    const match = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.devtunnels\.ms/i.exec(chunk);
    if (match && !publicUrl && !chunk.includes('-inspect')) publicUrl = match[0];
  });
  tunnel.on('error', (err) => {
    if (!shuttingDown) shutdown(`Could not start the dev tunnel: ${err.message}`, 1);
  });
  tunnel.on('exit', (code) => {
    if (!shuttingDown) shutdown(`Dev tunnel exited unexpectedly (code ${code})`, 1);
  });

  if (
    !(await waitFor('the tunnel to connect', () => Promise.resolve(Boolean(publicUrl)), 60_000))
  ) {
    shutdown('Tunnel did not start', 1);
    return;
  }
  console.log(`  connected: ${publicUrl}`);

  // The bot's messaging endpoint in the Developer Portal must match this URL.
  const expected = config.TEAMS_PUBLIC_URL.trim().replace(/\/+$/, '');
  if (expected && expected !== publicUrl) {
    console.log(`\n  !! Tunnel URL does not match TEAMS_PUBLIC_URL in .env`);
    console.log(`     tunnel   : ${publicUrl}`);
    console.log(`     expected : ${expected}`);
    console.log(`     Teams will POST to the expected URL, so update the bot's`);
    console.log(`     "Endpoint address" in the Developer Portal to:`);
    console.log(`       ${publicUrl}${config.TEAMS_MESSAGING_ENDPOINT}\n`);
  } else if (expected) {
    console.log(
      `  matches TEAMS_PUBLIC_URL — bot endpoint ${publicUrl}${config.TEAMS_MESSAGING_ENDPOINT}`,
    );
  } else {
    console.log(`  bot endpoint should be: ${publicUrl}${config.TEAMS_MESSAGING_ENDPOINT}`);
    console.log(`  (set TEAMS_PUBLIC_URL=${publicUrl} in .env and this is checked automatically)`);
  }

  // ---- 4. StandSync --------------------------------------------------------
  console.log('\n[4/5] StandSync');
  // Launch through the Node binary and tsx's own entry file rather than `npx`:
  // on Windows `npx` is a .cmd shim, which spawn({ shell: false }) cannot resolve,
  // and enabling a shell just to find it would put user input near a command line.
  const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
  if (!existsSync(tsxCli)) {
    console.log(`  tsx not found at ${tsxCli} — run: npm install\n`);
    shutdown('Missing dependencies', 1);
    return;
  }
  const server = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: {
      ...process.env,
      // Pin the CLI by absolute path so interpretation no longer depends on how
      // this terminal (or VS Code) inherited PATH.
      ...(claudePath ? { CLAUDE_CODE_PATH: claudePath } : {}),
    },
  });
  children.push(server);
  server.on('error', (err) => {
    if (!shuttingDown) shutdown(`Could not start StandSync: ${err.message}`, 1);
  });
  server.on('exit', (code) => {
    if (!shuttingDown) shutdown(`StandSync exited unexpectedly (code ${code})`, 1);
  });

  if (!(await waitFor('StandSync to listen', () => portResponds(config.PORT), 90_000))) {
    shutdown('StandSync did not start', 1);
    return;
  }

  // ---- 5. Verify the public chain -----------------------------------------
  console.log('\n[5/5] Verifying the chain Teams actually uses');
  const verdicts: CheckResult[] = [];

  const localHealth = await fetch(`http://127.0.0.1:${config.PORT}/health`).then(
    (r) => r.status,
    () => 0,
  );
  verdicts.push(
    localHealth === 200
      ? ok('local', 'GET /health → 200')
      : fail('local', `GET /health → ${localHealth}`),
  );

  const publicHealth = await fetch(`${publicUrl}/health`, {
    signal: AbortSignal.timeout(40_000),
  }).then(
    (r) => r.status,
    () => 0,
  );
  verdicts.push(
    publicHealth === 200
      ? ok('public', `GET ${publicUrl}/health → 200`)
      : fail(
          'public',
          `GET ${publicUrl}/health → ${publicHealth || 'no response'}`,
          'The tunnel is not forwarding.',
        ),
  );

  // 401 is the healthy answer: the route exists and Teams auth is enforced.
  // 404 would mean Teams is disabled; anything else means the chain is broken.
  const messages = await fetch(`${publicUrl}${config.TEAMS_MESSAGING_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message' }),
    signal: AbortSignal.timeout(40_000),
  }).then(
    (r) => r.status,
    () => 0,
  );
  if (messages === 401) {
    verdicts.push(
      ok('messages', `POST ${config.TEAMS_MESSAGING_ENDPOINT} → 401 (mounted, auth enforced)`),
    );
  } else if (messages === 404) {
    verdicts.push(
      fail(
        'messages',
        'endpoint returns 404 — Teams is disabled',
        'Set MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD.',
      ),
    );
  } else {
    verdicts.push(fail('messages', `unexpected HTTP ${messages || 'no response'}`));
  }

  console.log();
  const healthy = report(verdicts);

  line();
  if (!healthy) {
    console.log('Chain verification FAILED — Teams will not reach StandSync.');
    console.log('Leaving processes running so you can inspect the logs. Ctrl+C to stop.');
    line();
    return;
  }

  console.log('READY — send this in the Teams channel:\n');
  console.log('    @StandSync I completed TES-18\n');
  console.log(`  tunnel     ${publicUrl}`);
  console.log(`  endpoint   ${publicUrl}${config.TEAMS_MESSAGING_ENDPOINT}`);
  console.log(
    `  channel    ${config.TEAMS_ALLOWED_CONVERSATION_ID || '(not set — every message ignored)'}`,
  );
  console.log(`  claude     ${claudePath ?? '(PATH)'}`);
  console.log('\n  Ctrl+C stops StandSync and the tunnel together.');
  line();
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  shutdown('Startup failed', 1);
});
