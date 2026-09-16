/**
 * Finding and stopping the long-running processes this project owns.
 *
 * Kept free of side effects so the matching rule can be unit tested — it decides
 * what gets killed, which is not something to leave unverified.
 */
import { execFileSync } from 'node:child_process';

export interface Proc {
  pid: number;
  name: string;
  commandLine: string;
}

export const DEFAULT_TUNNEL_ID = 'standsync';

/**
 * True when the process is StandSync's server, the demo orchestrator, or the
 * dev tunnel for this project.
 *
 * Matched on the ENTRY POINT, never the project path. The path contains
 * "StandSync", so matching on it would also select `npx vitest`, `tsc`, `eslint`
 * and `prettier` started from this directory — and stopping the demo would then
 * kill a running test suite or the editor's type checker.
 */
export function isOurLongRunningProcess(
  proc: Proc,
  opts: { tunnelId?: string; selfPid?: number } = {},
): boolean {
  const tunnelId = opts.tunnelId ?? DEFAULT_TUNNEL_ID;
  if (opts.selfPid !== undefined && proc.pid === opts.selfPid) return false;

  if (proc.name.toLowerCase() === 'devtunnel.exe') {
    return proc.commandLine.includes(tunnelId);
  }

  return (
    /src[/\\]index\.ts/.test(proc.commandLine) ||
    /dist[/\\]index\.js/.test(proc.commandLine) ||
    /scripts[/\\]demo\.ts/.test(proc.commandLine)
  );
}

/** Human-readable label for what a matched process is. */
export function describeProcess(proc: Proc): string {
  if (proc.name.toLowerCase() === 'devtunnel.exe') return 'dev tunnel';
  if (/scripts[/\\]demo\.ts/.test(proc.commandLine)) return 'demo orchestrator';
  if (/\bwatch\b/.test(proc.commandLine)) return 'tsx watch supervisor';
  return 'server';
}

/** Every node/devtunnel process currently running, with its command line. */
export function listProcesses(): Proc[] {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','devtunnel.exe') } | " +
        'ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, name, ...rest] = l.split('|');
      return { pid: Number(pid), name: name ?? '', commandLine: rest.join('|') };
    });
}

/** Kills a process and everything it spawned; a bare kill leaves grandchildren. */
export function killTree(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
