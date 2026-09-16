/**
 * Stops anything this project left running: the StandSync server (including a
 * `tsx watch` supervisor) and the dev tunnel host.
 *
 * `npm run demo` cleans up on Ctrl+C, but a closed terminal or a crashed session
 * can leave a supervisor behind that immediately respawns a child on port 3978 —
 * which then looks like "the port is mysteriously in use". This clears that
 * reliably, and only ever touches processes belonging to this project.
 */
import { execFileSync } from 'node:child_process';

interface Proc {
  pid: number;
  name: string;
  commandLine: string;
}

function listProcesses(): Proc[] {
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

function killTree(pid: number): boolean {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TUNNEL_ID = process.env['DEVTUNNEL_ID'] ?? 'standsync';

const procs = listProcesses();

// Only this project's processes. Other Node apps on this machine are left alone.
const targets = procs.filter(
  (p) =>
    /StandSync|HeartForge/i.test(p.commandLine) ||
    (p.name === 'devtunnel.exe' && p.commandLine.includes(TUNNEL_ID)),
);

if (targets.length === 0) {
  console.log('\nNothing to stop — no StandSync or dev tunnel processes are running.\n');
  process.exit(0);
}

console.log('\nStopping StandSync development processes:\n');
for (const t of targets) {
  const kind =
    t.name === 'devtunnel.exe'
      ? 'dev tunnel'
      : /watch/.test(t.commandLine)
        ? 'tsx watch'
        : 'server';
  console.log(
    `  ${killTree(t.pid) ? 'stopped' : 'gone   '}  PID ${String(t.pid).padEnd(7)} ${kind}`,
  );
}

setTimeout(() => {
  const left = listProcesses().filter(
    (p) =>
      /StandSync|HeartForge/i.test(p.commandLine) ||
      (p.name === 'devtunnel.exe' && p.commandLine.includes(TUNNEL_ID)),
  );
  console.log(
    left.length === 0 ? '\nAll clear.\n' : `\n${left.length} process(es) still running.\n`,
  );
}, 1200);
