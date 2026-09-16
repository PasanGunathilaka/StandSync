/**
 * Preflight checks for the local Teams demo.
 *
 * Every dependency the Teams path needs is verified *before* anything starts, so
 * a broken demo fails here with a specific instruction rather than halfway
 * through a live presentation. Each check returns a result rather than throwing,
 * so one run reports every problem at once.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { loadConfig, type Config } from '../../src/config.js';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What the operator should do about it. */
  fix?: string;
}

export const ok = (name: string, detail: string): CheckResult => ({ name, status: 'pass', detail });
export const warn = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: 'warn',
  detail,
  ...(fix ? { fix } : {}),
});
export const fail = (name: string, detail: string, fix?: string): CheckResult => ({
  name,
  status: 'fail',
  detail,
  ...(fix ? { fix } : {}),
});

/** Config loads and every required variable is present. */
export function checkConfig(): { result: CheckResult; config?: Config } {
  try {
    const config = loadConfig();
    return {
      result: ok(
        'config',
        `.env loaded — provider ${config.LLM_PROVIDER}, Jira ${config.JIRA_BASE_URL}`,
      ),
      config,
    };
  } catch (err) {
    return {
      result: fail(
        'config',
        err instanceof Error ? err.message.split('\n').slice(0, 4).join(' ') : String(err),
        'Copy .env.example to .env and fill in the blanks.',
      ),
    };
  }
}

/**
 * Resolves the Claude Code CLI to an ABSOLUTE path.
 *
 * `claude.exe` normally lives on the *user* PATH, so whether a bare `claude`
 * resolves depends on how the terminal (or VS Code) was launched. Pinning an
 * absolute path removes that variable entirely — the returned path is handed to
 * the server as CLAUDE_CODE_PATH.
 */
export async function resolveClaude(
  configured: string,
): Promise<{ result: CheckResult; path?: string }> {
  const candidates: string[] = [];

  // An explicitly configured absolute path always wins.
  if (configured && configured !== 'claude') candidates.push(configured);

  // Ask the shell where it thinks claude is.
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-Command claude -ErrorAction SilentlyContinue).Source'],
      { timeout: 20_000 },
    );
    const found = stdout.trim();
    if (found) candidates.push(found);
  } catch {
    /* fall through to the well-known locations below */
  }

  // Well-known install locations, in case PATH is not inherited at all.
  const local = process.env['LOCALAPPDATA'];
  if (local) {
    candidates.push(`${local}\\Microsoft\\WinGet\\Links\\claude.exe`);
    candidates.push(`${local}\\Programs\\claude\\claude.exe`);
  }

  const resolved = candidates.find((c) => existsSync(c));
  if (!resolved) {
    return {
      result: fail(
        'claude cli',
        'could not locate claude.exe',
        'Install Claude Code, or set CLAUDE_CODE_PATH in .env to its absolute path.',
      ),
    };
  }

  // Confirm it actually runs — presence on disk is not the same as working.
  try {
    const { stdout } = await execFileAsync(resolved, ['--version'], { timeout: 30_000 });
    return {
      result: ok('claude cli', `${stdout.trim().split('\n')[0]} — ${resolved}`),
      path: resolved,
    };
  } catch (err) {
    return {
      result: fail(
        'claude cli',
        `found at ${resolved} but it failed to run: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        'Run `claude --version` manually, and `claude` once to sign in if needed.',
      ),
      path: resolved,
    };
  }
}

/** Jira credentials work and the API answers. */
export async function checkJira(config: Config): Promise<CheckResult> {
  const auth = Buffer.from(`${config.JIRA_EMAIL}:${config.JIRA_API_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`${config.JIRA_BASE_URL.replace(/\/+$/, '')}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) {
      return fail(
        'jira',
        `credentials rejected (HTTP ${res.status})`,
        'Check JIRA_EMAIL and JIRA_API_TOKEN in .env.',
      );
    }
    if (!res.ok) return fail('jira', `unexpected HTTP ${res.status}`);
    const me = (await res.json()) as { displayName?: string };
    return ok('jira', `authenticated as ${me.displayName ?? 'unknown user'}`);
  } catch (err) {
    return fail(
      'jira',
      `could not reach ${config.JIRA_BASE_URL}: ${err instanceof Error ? err.message : String(err)}`,
      'Check JIRA_BASE_URL and your network connection.',
    );
  }
}

/** Teams credentials mint a Bot Framework token for the configured tenant. */
export async function checkTeams(config: Config): Promise<CheckResult> {
  if (!config.MICROSOFT_APP_ID || !config.MICROSOFT_APP_PASSWORD) {
    return warn(
      'teams',
      'MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD not set — Teams is disabled, /dev/* still works',
      'Set both in .env to enable the Teams demo.',
    );
  }
  if (!config.TEAMS_ALLOWED_CONVERSATION_ID) {
    return warn(
      'teams',
      'TEAMS_ALLOWED_CONVERSATION_ID is blank — StandSync will ignore every message',
      'Post in the channel once, then copy the id from the log into .env.',
    );
  }

  const tenant = config.MICROSOFT_APP_TENANT_ID || 'botframework.com';
  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.MICROSOFT_APP_ID,
        client_secret: config.MICROSOFT_APP_PASSWORD,
        scope: 'https://api.botframework.com/.default',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      return fail(
        'teams',
        `bot credentials rejected: ${body.error ?? res.status}`,
        'Check MICROSOFT_APP_ID / PASSWORD / TENANT_ID against the Developer Portal.',
      );
    }
    return ok('teams', `bot credentials valid for tenant ${tenant}`);
  } catch (err) {
    return fail(
      'teams',
      `token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface PortOwner {
  pid: number;
  commandLine: string;
  isStandSync: boolean;
}

/** Who, if anyone, is listening on the port. */
export function whoHasPort(port: number): PortOwner | undefined {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
          `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; ` +
          `"$($p.ProcessId)|$($p.CommandLine)" }`,
      ],
      { encoding: 'utf8', timeout: 25_000 },
    ).trim();
    if (!out) return undefined;
    const sep = out.indexOf('|');
    const pid = Number(out.slice(0, sep));
    const commandLine = out.slice(sep + 1);
    return {
      pid,
      commandLine,
      isStandSync: /StandSync|HeartForge/i.test(commandLine),
    };
  } catch {
    return undefined;
  }
}

/** True once something accepts a TCP connection on the port. */
export function portResponds(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

export interface TunnelState {
  exists: boolean;
  hostConnections: number;
}

/** Reads the persistent tunnel's state from `devtunnel list`. */
export async function checkTunnelDefinition(
  tunnelId: string,
): Promise<{ result: CheckResult; state: TunnelState }> {
  try {
    const { stdout } = await execFileAsync('devtunnel', ['list'], { timeout: 45_000 });
    const line = stdout.split('\n').find((l) => l.includes(tunnelId));
    if (!line) {
      return {
        result: fail(
          'dev tunnel',
          `no persistent tunnel named "${tunnelId}"`,
          `Create it once: devtunnel create ${tunnelId} --allow-anonymous && devtunnel port create ${tunnelId} -p 3978`,
        ),
        state: { exists: false, hostConnections: 0 },
      };
    }
    // Columns: <id> <hostConnections> [labels] <ports> <expiration>
    const cols = line.trim().split(/\s{2,}/);
    const hostConnections = Number(cols[1] ?? 0) || 0;
    return {
      result: ok('dev tunnel', `"${tunnelId}" exists (host connections: ${hostConnections})`),
      state: { exists: true, hostConnections },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not recognized|ENOENT/i.test(message)) {
      return {
        result: fail(
          'dev tunnel',
          'devtunnel CLI not installed',
          'winget install Microsoft.devtunnel',
        ),
        state: { exists: false, hostConnections: 0 },
      };
    }
    return {
      result: fail(
        'dev tunnel',
        `devtunnel list failed: ${message.split('\n')[0]}`,
        'Run: devtunnel user login',
      ),
      state: { exists: false, hostConnections: 0 },
    };
  }
}

/** Renders a result list and returns true when nothing failed. */
export function report(results: CheckResult[]): boolean {
  const icon = { pass: 'OK  ', warn: 'WARN', fail: 'FAIL' } as const;
  for (const r of results) {
    console.log(`  ${icon[r.status]} ${r.name.padEnd(12)} ${r.detail}`);
    if (r.fix && r.status !== 'pass') console.log(`       ↳ ${r.fix}`);
  }
  return !results.some((r) => r.status === 'fail');
}
