/**
 * Stops anything this project left running: the StandSync server (including a
 * `tsx watch` supervisor), the demo orchestrator, and the dev tunnel host.
 *
 * `npm run demo` cleans up on Ctrl+C, but a closed terminal or a crashed session
 * can leave a supervisor behind that immediately respawns a child on port 3978 —
 * which then looks like "the port is mysteriously in use". This clears that
 * reliably, and only ever touches this project's long-running processes.
 */
import {
  DEFAULT_TUNNEL_ID,
  describeProcess,
  isOurLongRunningProcess,
  killTree,
  listProcesses,
} from './lib/processes.js';

const tunnelId = process.env['DEVTUNNEL_ID'] ?? DEFAULT_TUNNEL_ID;
const match = (p: Parameters<typeof isOurLongRunningProcess>[0]): boolean =>
  isOurLongRunningProcess(p, { tunnelId, selfPid: process.pid });

const targets = listProcesses().filter(match);

if (targets.length === 0) {
  console.log('\nNothing to stop — no StandSync server, demo or dev tunnel is running.\n');
  process.exit(0);
}

console.log('\nStopping StandSync development processes:\n');
for (const t of targets) {
  const stopped = killTree(t.pid);
  console.log(
    `  ${stopped ? 'stopped' : 'gone   '}  PID ${String(t.pid).padEnd(7)} ${describeProcess(t)}`,
  );
}

setTimeout(() => {
  const left = listProcesses().filter(match);
  console.log(
    left.length === 0 ? '\nAll clear.\n' : `\n${left.length} process(es) still running.\n`,
  );
}, 1200);
