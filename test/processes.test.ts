import { describe, it, expect } from 'vitest';
import { describeProcess, isOurLongRunningProcess, type Proc } from '../scripts/lib/processes.js';

/**
 * This predicate decides what `npm run demo:stop` KILLS, so its blast radius is
 * worth pinning down.
 *
 * The original version matched /StandSync|HeartForge/ against the command line.
 * That string appears in the project path, so it also matched `npx vitest`,
 * `tsc`, `eslint` and `prettier` launched from this directory — stopping the
 * demo would have killed a running test suite. Matching the entry point instead
 * keeps the rule tight.
 */
const BASE = 'C:\\Learnings\\Projects\\HeartForge Competition\\StandSync';
const proc = (name: string, commandLine: string, pid = 100): Proc => ({ pid, name, commandLine });

describe('isOurLongRunningProcess — what demo:stop will kill', () => {
  it('matches the StandSync server however it was launched', () => {
    expect(
      isOurLongRunningProcess(
        proc('node.exe', `node ${BASE}\\node_modules\\tsx\\dist\\cli.mjs src/index.ts`),
      ),
    ).toBe(true);
    expect(
      isOurLongRunningProcess(
        proc('node.exe', `node ${BASE}\\node_modules\\tsx\\dist\\cli.mjs watch src/index.ts`),
      ),
    ).toBe(true);
    expect(isOurLongRunningProcess(proc('node.exe', `node ${BASE}\\dist\\index.js`))).toBe(true);
  });

  it('matches the demo orchestrator', () => {
    expect(isOurLongRunningProcess(proc('node.exe', 'node tsx/cli.mjs scripts/demo.ts'))).toBe(
      true,
    );
  });

  it('matches our dev tunnel but not somebody else’s', () => {
    expect(isOurLongRunningProcess(proc('devtunnel.exe', 'devtunnel host standsync'))).toBe(true);
    expect(isOurLongRunningProcess(proc('devtunnel.exe', 'devtunnel host other-project'))).toBe(
      false,
    );
  });

  // The regression that matters: tooling run from this directory must survive.
  it('does NOT match project tooling launched from this directory', () => {
    const tooling = [
      `node ${BASE}\\node_modules\\vitest\\vitest.mjs run`,
      `node ${BASE}\\node_modules\\typescript\\bin\\tsc -p tsconfig.json --noEmit`,
      `node ${BASE}\\node_modules\\eslint\\bin\\eslint.js .`,
      `node ${BASE}\\node_modules\\prettier\\bin\\prettier.cjs --write .`,
      `node ${BASE}\\node_modules\\tsx\\dist\\cli.mjs scripts/seed-jira.ts`,
    ];
    for (const cmd of tooling) {
      expect(isOurLongRunningProcess(proc('node.exe', cmd)), cmd).toBe(false);
    }
  });

  it('does not match unrelated applications', () => {
    expect(
      isOurLongRunningProcess(
        proc('node.exe', 'node C:\\Learnings\\Projects\\bcpm-mod\\web\\node_modules\\next dev'),
      ),
    ).toBe(false);
  });

  it('never matches itself', () => {
    const self = proc('node.exe', 'node scripts/demo.ts', 4242);
    expect(isOurLongRunningProcess(self)).toBe(true);
    expect(isOurLongRunningProcess(self, { selfPid: 4242 })).toBe(false);
  });

  it('honours a custom tunnel id', () => {
    const p = proc('devtunnel.exe', 'devtunnel host my-tunnel');
    expect(isOurLongRunningProcess(p)).toBe(false);
    expect(isOurLongRunningProcess(p, { tunnelId: 'my-tunnel' })).toBe(true);
  });
});

describe('describeProcess', () => {
  it('labels each kind for the stop output', () => {
    expect(describeProcess(proc('devtunnel.exe', 'devtunnel host standsync'))).toBe('dev tunnel');
    expect(describeProcess(proc('node.exe', 'node tsx/cli.mjs scripts/demo.ts'))).toBe(
      'demo orchestrator',
    );
    expect(describeProcess(proc('node.exe', 'node tsx/cli.mjs watch src/index.ts'))).toBe(
      'tsx watch supervisor',
    );
    expect(describeProcess(proc('node.exe', 'node tsx/cli.mjs src/index.ts'))).toBe('server');
  });
});
