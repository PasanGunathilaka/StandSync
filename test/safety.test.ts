import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

/**
 * Architecture tests for the V2 trust boundary.
 *
 * These are code-level guards, not behavioural tests. The point is to make the
 * central invariant hard to violate *by accident*: a future change that hands a
 * reasoning agent a Jira write client, or adds a second mutation path, should
 * fail the build rather than be caught in review.
 *
 * The boundary being enforced:
 *
 *   Teams -> ingress -> AI reasoning -> proposals -> human approval
 *         -> executeBatch() -> Jira
 *
 * Claude may reason about Jira. Claude may never mutate Jira.
 */

/**
 * Paths are resolved as URLs relative to this file and handed straight to
 * readFile, matching the V1 architecture test. Converting to a string first
 * would leave "%20" in a repository path containing a space.
 */
async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

interface SourceFile {
  path: string;
  text: string;
}

/** Every .ts file under a source directory, with its repo-relative path. */
async function load(dir: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(new URL(`../${relativeDir}`, import.meta.url), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const rel = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.name.endsWith('.ts')) found.push({ path: rel, text: await read(rel) });
    }
  }

  await walk(dir);
  return found;
}

/**
 * Source with comments removed.
 *
 * These are guards against *code* reaching for a capability. A doc comment that
 * mentions executeBatch to explain why it is not used must not fail the guard —
 * otherwise the tests punish documentation, and the honest response would be to
 * delete the explanation.
 */
function code(file: SourceFile): string {
  return file.text
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' '); // line comments
}

/** Import specifiers only, so a mention in a string or comment does not count. */
function imports(file: SourceFile): string[] {
  return [...code(file).matchAll(/from\s+['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? '');
}

/** Every module StandSync ships. */
const allSource = (): Promise<SourceFile[]> => load('src');

describe('Jira mutation has exactly one call site', () => {
  it('only src/approval/execute.ts calls transitionIssue or addComment', async () => {
    const files = await allSource();

    const callers = files
      .filter((f) => f.path !== 'src/jira/actions.ts')
      .filter((f) => /\.(transitionIssue|addComment)\(/.test(f.text))
      .map((f) => f.path);

    // This is the V1 invariant, preserved verbatim through V2.
    expect(callers).toEqual(['src/approval/execute.ts']);
  });

  it('JiraActions exposes only the two intended write methods', async () => {
    const actions = { path: 'src/jira/actions.ts', text: await read('src/jira/actions.ts') };
    const methods = [...code(actions).matchAll(/^\s{2}(?:async\s+)?([a-zA-Z]+)\(/gm)]
      .map((m) => m[1])
      .filter((name) => name !== 'constructor');

    expect(methods).toEqual(['transitionIssue', 'addComment']);
  });

  it('nothing but JiraActions issues a Jira issue-mutating request', async () => {
    const files = await allSource();

    // Checked per request rather than per file: src/jira/issues.ts legitimately
    // POSTs to /search/jql, which is a read in Jira's API. What must not exist
    // anywhere else is a POST/PUT to an issue's /transitions or /comment.
    const offenders = files
      .filter((f) => f.path !== 'src/jira/actions.ts')
      .filter((f) => {
        const source = code(f);
        return [...source.matchAll(/method:\s*'(?:POST|PUT)'/g)].some((match) => {
          const window = source.slice(Math.max(0, match.index - 300), match.index + 300);
          return /\/issue\/[^'`]*\/(transitions|comment)/.test(window);
        });
      })
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('the Jira reads module performs no issue mutation', async () => {
    const issues = { path: 'src/jira/issues.ts', text: await read('src/jira/issues.ts') };
    const source = code(issues);

    // The one POST here is /search/jql, which reads.
    expect(source).toContain('/rest/api/3/search/jql');

    const writes = [...source.matchAll(/method:\s*'(?:POST|PUT)'/g)].map((match) =>
      source.slice(Math.max(0, match.index - 300), match.index + 300),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('/search/jql');
  });
});

describe('the agent layer holds no Jira write capability', () => {
  it('no agent imports the Jira write client', async () => {
    const agents = await load('src/agents');
    const offenders = agents.filter((f) => f.text.includes('jira/actions')).map((f) => f.path);

    // An agent that can import JiraActions is one refactor away from using it.
    expect(offenders).toEqual([]);
  });

  it('no skill imports the Jira write client', async () => {
    const skills = await load('src/skills');
    const offenders = skills.filter((f) => f.text.includes('jira/actions')).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no agent or skill imports the approval executor', async () => {
    const files = [...(await load('src/agents')), ...(await load('src/skills'))];
    const offenders = files
      .filter((f) => imports(f).some((spec) => spec.includes('approval/execute')))
      .map((f) => f.path);

    // Reasoning must not be able to reach the write boundary directly; only a
    // human-driven card action or dev endpoint may.
    expect(offenders).toEqual([]);
  });

  it('no agent or skill calls executeBatch', async () => {
    const files = [...(await load('src/agents')), ...(await load('src/skills'))];
    const offenders = files.filter((f) => /executeBatch\s*\(/.test(code(f))).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no agent or skill constructs a JiraClient', async () => {
    const files = [...(await load('src/agents')), ...(await load('src/skills'))];
    const offenders = files.filter((f) => /new JiraClient\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the summary service holds no write capability', async () => {
    const summary = { path: 'src/summary/service.ts', text: await read('src/summary/service.ts') };

    expect(imports(summary).some((s) => s.includes('jira/actions'))).toBe(false);
    expect(imports(summary).some((s) => s.includes('approval/execute'))).toBe(false);
    // No reference to the write client in code — a comment explaining its
    // absence is exactly what we want to keep.
    expect(code(summary)).not.toContain('JiraActions');
    expect(code(summary)).not.toContain('transitionIssue');
    expect(code(summary)).not.toContain('addComment');
  });

  it('the decision policy is pure — it neither reads nor writes Jira', async () => {
    const policy = await read('src/policy/decision-policy.ts');
    expect(policy).not.toContain('jira/actions');
    expect(policy).not.toContain('jira/client');
    expect(policy).not.toContain('jira/issues');
    expect(policy).not.toContain('await ');
  });

  it('AgentDeps grants an LLM client, a store and a logger — nothing else', async () => {
    const types = await read('src/agents/types.ts');
    const block = /export interface AgentDeps \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';

    expect(block).toContain('llm: LLMClient');
    expect(block).not.toContain('JiraActions');
    expect(block).not.toContain('JiraClient');
    expect(block).not.toMatch(/\bactions\b/);
  });

  it('the orchestrator receives a reads-only Jira service', async () => {
    const orchestrator = await read('src/agents/orchestrator.ts');
    const block =
      /export interface OrchestratorDeps \{([\s\S]*?)\n\}/.exec(orchestrator)?.[1] ?? '';

    expect(block).toContain('context: JiraContextService');
    expect(block).not.toContain('JiraActions');
  });

  it('buildContext constructs the context service without JiraActions', async () => {
    const index = await read('src/index.ts');
    expect(index).toMatch(/new JiraContextService\(\{\s*client,\s*issues\s*\}\)/);
  });
});

describe('Claude is never given Jira credentials', () => {
  it('no agent or skill reads a Jira credential from config', async () => {
    const files = [...(await load('src/agents')), ...(await load('src/skills'))];
    for (const file of files) {
      expect(file.text, `${file.path} must not read Jira credentials`).not.toContain(
        'JIRA_API_TOKEN',
      );
      expect(file.text, `${file.path} must not read Jira credentials`).not.toContain('JIRA_EMAIL');
      expect(file.text, `${file.path} must not read the Jira base URL`).not.toContain(
        'JIRA_BASE_URL',
      );
    }
  });

  it('the Jira context service sends no credential or URL downstream', async () => {
    const context = await read('src/jira/context.ts');
    const promptBlock =
      /export function describeContextForPrompt\(([\s\S]*?)\n\}/.exec(context)?.[0] ?? '';

    expect(promptBlock).not.toContain('authHeader');
    expect(promptBlock).not.toContain('baseUrl');
    expect(promptBlock).not.toContain('apiToken');
  });

  it('the sanitized issue context carries no transition ids', async () => {
    const context = await read('src/jira/context.ts');
    const shape = /export interface IssueContext \{([\s\S]*?)\n\}/.exec(context)?.[1] ?? '';

    // Transition ids are what actually perform a Jira write. A model that can
    // name one is a model participating in the mutation.
    expect(shape).not.toContain('transitionId');
    expect(shape).toContain('availableTransitions: string[]');
  });
});

describe('the Claude Code provider keeps its V1 safety guarantees', () => {
  it('still disables all tools, and keeps --tools "" terminal', async () => {
    const provider = await read('src/llm/claudeCode.ts');
    expect(provider).toContain("'--tools'");
    expect(provider).toContain('assertToolsFlagIsLast');
    expect(provider).toContain('verifyToolSuppressionSupported');
    expect(provider).toContain('--safe-mode');
    expect(provider).toContain('--disable-slash-commands');
  });

  it('still refuses a result produced with tool access', async () => {
    const provider = await read('src/llm/claudeCode.ts');
    expect(provider).toContain('assertNoToolsWereUsed');
  });

  it('V2 did not add a second Claude integration', async () => {
    const files = await allSource();
    const spawners = files
      .filter((f) => /spawn\(/.test(f.text) && !f.path.startsWith('src/llm/'))
      .map((f) => f.path);

    // Every agent goes through the existing LLMClient abstraction.
    expect(spawners).toEqual([]);

    const sdkUsers = files.filter((f) => f.text.includes('@anthropic-ai/sdk')).map((f) => f.path);
    expect(sdkUsers).toEqual(['src/llm/anthropic.ts']);
  });

  it('every agent calls the model through runAgent', async () => {
    const agents = (await load('src/agents')).filter(
      (f) => !f.path.endsWith('runAgent.ts') && !f.path.endsWith('types.ts'),
    );

    for (const agent of agents) {
      // No agent may call llm.complete() directly: runAgent is what guarantees
      // schema re-validation, the single retry and the audit row.
      expect(agent.text, `${agent.path} must not call the provider directly`).not.toContain(
        '.complete(',
      );
    }
  });

  it('the model is never hardcoded — it comes from configuration', async () => {
    const files = await allSource();
    const hardcoded = files
      .filter((f) => f.path !== 'src/config.ts')
      .filter((f) => /['"]claude-(sonnet|opus|haiku)-[\d.]/.test(f.text))
      .map((f) => f.path);

    expect(hardcoded).toEqual([]);
    expect(await read('src/config.ts')).toContain('ANTHROPIC_MODEL');
  });
});

describe('every agent output is schema validated', () => {
  it('each skill declares both a JSON schema and a zod schema', async () => {
    const skills = (await load('src/skills')).filter(
      // explain-proposal is deterministic by design: it composes established
      // facts rather than calling a model, so it has no schema to validate.
      (f) => !f.path.endsWith('explain-proposal.ts'),
    );

    expect(skills.length).toBeGreaterThanOrEqual(6);

    for (const skill of skills) {
      expect(skill.text, `${skill.path} needs a JSON schema`).toContain('jsonSchema:');
      expect(skill.text, `${skill.path} needs a zod output schema`).toContain('outputSchema:');
      expect(skill.text, `${skill.path} needs a purpose`).toContain('purpose:');
    }
  });

  it('runAgent always re-validates with zod before returning', async () => {
    const runner = await read('src/agents/runAgent.ts');
    expect(runner).toContain('skill.outputSchema.safeParse');
    // The success path must be reachable only through a successful parse.
    expect(runner).toMatch(/if \(parsed\.success\) \{[\s\S]*?ok: true/);
  });

  it('every skill forbids tool use in its system prompt', async () => {
    const skills = (await load('src/skills')).filter(
      (f) => !f.path.endsWith('explain-proposal.ts'),
    );

    for (const skill of skills) {
      expect(skill.text, `${skill.path} must tell the model not to use tools`).toMatch(
        /Do not use any tools/,
      );
    }
  });
});

describe('the approval boundary is preserved', () => {
  it('executeBatch still claims the batch before any Jira call', async () => {
    const execute = await read('src/approval/execute.ts');

    const claimIndex = execute.indexOf('claimForExecution');
    const applyIndex = execute.indexOf('applyProposal(actions');
    expect(claimIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(-1);
    // Claim first, act second. This is the whole idempotency guarantee.
    expect(claimIndex).toBeLessThan(applyIndex);
  });

  it('claimForExecution is still a conditional single-row update', async () => {
    const store = await read('src/approval/store.ts');
    expect(store).toMatch(/WHERE id = \? AND status = 'pending'/);
    expect(store).toContain('info.changes === 1');
  });

  it('the V2 card actions cannot reach executeBatch', async () => {
    const actions = await read('src/teams/actions.ts');

    // The clarify and summary verbs return before the approval block. Both are
    // injected handlers, so this module cannot execute a batch on their behalf.
    const clarifyIndex = actions.indexOf("parsed.action === 'clarify'");
    const executeIndex = actions.indexOf('await executeBatch(');
    expect(clarifyIndex).toBeGreaterThan(-1);
    expect(clarifyIndex).toBeLessThan(executeIndex);
  });

  it('resolving a clarification produces a pending batch, never an execution', async () => {
    const file = {
      path: 'src/agents/clarification.ts',
      text: await read('src/agents/clarification.ts'),
    };
    const source = code(file);

    expect(source).toContain("status: 'pending'");
    expect(source).not.toMatch(/executeBatch\s*\(/);
    expect(source).not.toContain('transitionIssue');
    expect(source).not.toContain('addComment');
  });

  it('the orchestrator only ever stores a pending batch', async () => {
    const file = {
      path: 'src/agents/orchestrator.ts',
      text: await read('src/agents/orchestrator.ts'),
    };
    const source = code(file);

    expect(source).toContain("status: 'pending'");
    expect(source).not.toMatch(/executeBatch\s*\(/);
    // The only batch status the orchestrator ever writes is 'pending'.
    const statuses = [...source.matchAll(/status: '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(statuses)]).toEqual(['pending']);
  });

  it('Teams and the dev endpoints share one orchestrator and one executor', async () => {
    const app = await read('src/teams/app.ts');
    const routes = await read('src/dev/routes.ts');

    for (const source of [app, routes]) {
      expect(source).toContain('orchestrateMessage(');
    }
    // No parallel interpretation or proposal building in either entry point.
    for (const source of [app, routes]) {
      expect(source).not.toContain('interpretWork(');
      expect(source).not.toContain('buildProposals(');
      expect(source).not.toContain('detectAmbiguity(');
    }
    expect(routes).toContain('executeBatch(');
  });
});

describe('secrets never reach a log or a prompt', () => {
  it('config names every secret it must never print', async () => {
    const config = await read('src/config.ts');
    expect(config).toContain('SECRET_KEYS');
    for (const key of ['ANTHROPIC_API_KEY', 'JIRA_API_TOKEN', 'MICROSOFT_APP_PASSWORD']) {
      expect(config).toContain(key);
    }
  });

  it('the logger redacts credentials as a backstop', async () => {
    const logger = await read('src/logger.ts');
    for (const path of ['token', 'password', 'authorization', 'JIRA_API_TOKEN']) {
      expect(logger).toContain(path);
    }
    expect(logger).toContain("censor: '[redacted]'");
  });

  it('no module logs a whole config or a raw secret', async () => {
    const files = await allSource();

    const offenders = files
      .filter((f) => {
        const source = code(f);
        // Logging `config` wholesale would print every credential. Logging a
        // named field (config.ANTHROPIC_MODEL) is fine and is done deliberately.
        return (
          /log(?:ger)?\.\w+\(\s*\{[^}]*(?:^|[\s,{])config\s*[,}]/m.test(source) ||
          /log(?:ger)?\.\w+\([^)]*\bconfig\.(?:JIRA_API_TOKEN|ANTHROPIC_API_KEY|MICROSOFT_APP_PASSWORD)\b/.test(
            source,
          )
        );
      })
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it('the observability layer documents what must never be logged', async () => {
    const stages = await read('src/observe/stages.ts');
    expect(stages).toMatch(/secret|credential/i);
  });

  it('agent runs store an outcome, not reasoning traces', async () => {
    const store = await read('src/approval/store.ts');
    // Chain-of-thought must not be persisted; only a short failure reason.
    expect(store).toContain('never reasoning');
    expect(store).toContain('.slice(0, 500)');
  });
});

describe('ambient listening is opt-in', () => {
  it('ambient mode is off by default', async () => {
    const config = await read('src/config.ts');
    const block = /STANDSYNC_AMBIENT_MODE: z[\s\S]*?\.default\('(\w+)'\)/.exec(config)?.[1] ?? '';
    expect(block).toBe('false');
  });

  it('there is no wildcard for observed conversations', async () => {
    const ambient = await read('src/teams/ambient.ts');
    expect(ambient).not.toContain("=== '*'");
    expect(ambient).toContain('There is intentionally no wildcard');
  });

  it('the manifest requests resource-specific consent, not tenant-wide scopes', async () => {
    const manifest = JSON.parse(await read('appPackage/manifest.json')) as {
      authorization?: {
        permissions?: { resourceSpecific?: { name: string; type: string }[] };
      };
      webApplicationInfo?: unknown;
    };

    const rsc = manifest.authorization?.permissions?.resourceSpecific ?? [];
    expect(rsc.map((p) => p.name)).toContain('ChannelMessage.Read.Group');
    expect(rsc.every((p) => p.type === 'Application')).toBe(true);

    // webApplicationInfo is how an app requests Graph scopes tenant-wide.
    // StandSync must not need it.
    expect(manifest.webApplicationInfo).toBeUndefined();
  });

  it('requests only read permissions on messages', async () => {
    const manifest = JSON.parse(await read('appPackage/manifest.json')) as {
      authorization?: { permissions?: { resourceSpecific?: { name: string }[] } };
    };
    const names = manifest.authorization?.permissions?.resourceSpecific?.map((p) => p.name) ?? [];

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `${name} must be a read-only permission`).toMatch(/\.Read\./);
    }
  });
});
