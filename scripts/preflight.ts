/**
 * Checks every dependency the Teams demo needs, without starting anything.
 *
 * Run it before a demo (`npm run preflight`) to confirm the environment is sound
 * while there is still time to fix it. `npm run demo` runs the same checks
 * automatically and refuses to start if any fail.
 */
import {
  checkConfig,
  checkJira,
  checkTeams,
  checkTunnelDefinition,
  ok,
  report,
  resolveClaude,
  warn,
  whoHasPort,
  type CheckResult,
} from './lib/preflight.js';

const TUNNEL_ID = process.env['DEVTUNNEL_ID'] ?? 'standsync';

async function main(): Promise<void> {
  console.log('\nStandSync preflight\n');
  const results: CheckResult[] = [];

  const { result: configResult, config } = checkConfig();
  results.push(configResult);

  if (config) {
    const [claude, jira, teams, tunnel] = await Promise.all([
      resolveClaude(config.CLAUDE_CODE_PATH),
      checkJira(config),
      checkTeams(config),
      checkTunnelDefinition(TUNNEL_ID),
    ]);
    results.push(claude.result, jira, teams, tunnel.result);

    if (tunnel.state.exists && tunnel.state.hostConnections === 0) {
      results.push(
        warn(
          'tunnel host',
          'the tunnel exists but nothing is hosting it — Teams cannot reach this machine',
          'Run `npm run demo`, which hosts it for you.',
        ),
      );
    } else if (tunnel.state.hostConnections > 0) {
      results.push(ok('tunnel host', `${tunnel.state.hostConnections} host connection(s)`));
    }

    const owner = whoHasPort(config.PORT);
    results.push(
      !owner
        ? ok('port', `${config.PORT} is free`)
        : owner.isStandSync
          ? warn(
              'port',
              `${config.PORT} held by a stale StandSync (PID ${owner.pid})`,
              '`npm run demo` clears it.',
            )
          : warn(
              'port',
              `${config.PORT} held by PID ${owner.pid} (not StandSync)`,
              'Stop it, or change PORT in .env.',
            ),
    );
  }

  console.log();
  const healthy = report(results);
  console.log();
  console.log(healthy ? 'Preflight passed.\n' : 'Preflight FAILED — fix the items above.\n');
  process.exit(healthy ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
