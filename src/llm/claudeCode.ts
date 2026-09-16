import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logger, type Logger } from '../logger.js';
import {
  LLMError,
  LLMTimeoutError,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

/**
 * Runs interpretation through the Claude Code CLI (`claude -p`).
 *
 * Why the CLI rather than the SDK: it authenticates with the developer's existing
 * Claude Code subscription login (or CLAUDE_CODE_OAUTH_TOKEN), so the build needs
 * no ANTHROPIC_API_KEY.
 *
 * Deliberately NOT using `--bare`: its own help states "Anthropic auth is strictly
 * ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never
 * read)", which is exactly the auth path we depend on.
 *
 * Safety properties:
 * - `shell: false` with an argv array, and the standup text goes over **stdin**.
 *   Untrusted message content is never part of a command line.
 * - The CLI is stripped to a pure text-in/JSON-out transform: no tools, no skills,
 *   no CLAUDE.md, no MCP. Interpreting a standup needs no filesystem access, and
 *   this also cut a measured call from ~$0.12/21.5s to ~$0.012/3.2s.
 * - Every call has a hard timeout; on expiry the child process tree is killed.
 */

/** The `--output-format json` envelope. Only the fields we actually rely on. */
const CliEnvelope = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  /** Prose summary. Deliberately unused — we read structured_output instead. */
  result: z.string().optional(),
  /** The schema-constrained object. This is the contract we depend on. */
  structured_output: z.unknown().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  session_id: z.string().optional(),
  /** Non-empty means something tried to use a tool that should not exist. */
  permission_denials: z.array(z.unknown()).optional(),
  usage: z
    .object({
      server_tool_use: z
        .object({
          web_search_requests: z.number().optional(),
          web_fetch_requests: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * The CLI contract StandSync depends on for tool suppression.
 *
 * `--tools` is documented as: "Specify the list of available tools from the
 * built-in set. Use "" to disable all tools". If a future CLI build drops the
 * flag, stops being variadic, or removes the empty-string semantics, passing
 * `--tools ""` could silently start meaning "all tools" instead of "none".
 * Interpreting a standup needs no filesystem, Bash, MCP or web access, so we
 * verify the contract up front and refuse to run if it no longer holds.
 */
const TOOLS_FLAG_SIGNATURE = /--tools\s+<tools\.\.\.>/;
const TOOLS_EMPTY_DISABLES = /use\s+""\s+to\s+disable\s+all\s+tools/i;

export interface ClaudeCodeOptions {
  model: string;
  /** Executable name or absolute path. Resolved via PATH when not absolute. */
  cliPath?: string;
  log?: Logger;
}

export class ClaudeCodeLLMClient implements LLMClient {
  readonly name = 'claude-code';
  readonly model: string;
  private readonly cliPath: string;
  private readonly log: Logger;
  /** Memoized --tools contract check; runs at most once per client. */
  private toolContractCheck: Promise<void> | undefined;

  constructor(opts: ClaudeCodeOptions) {
    this.model = opts.model;
    this.cliPath = opts.cliPath ?? 'claude';
    this.log = opts.log ?? logger;
  }

  /** The exact argv passed to the CLI. Exposed so tests and docs can assert it. */
  buildArgs(req: LLMRequest): string[] {
    return [
      '--print',
      '--output-format',
      'json',
      '--model',
      this.model,
      '--system-prompt',
      req.systemPrompt,
      '--json-schema',
      JSON.stringify(req.jsonSchema),
      // Strip everything a standup interpreter has no business touching.
      '--safe-mode',
      '--disable-slash-commands',
      // `--tools` is variadic (`--tools <tools...>`), so it consumes every
      // following argument that is not itself a flag. It MUST stay last: placed
      // anywhere else, the empty string plus whatever follows would be parsed as
      // a tool list, and tool suppression would silently break. The pair is kept
      // adjacent and terminal, and assertToolsFlagIsLast() enforces it.
      '--tools',
      '',
    ];
  }

  /**
   * Fails closed if `--tools ""` is not the final argument pair. Called on every
   * invocation so a future edit to buildArgs cannot quietly re-enable tools.
   */
  private assertToolsFlagIsLast(args: string[]): void {
    if (args.at(-2) !== '--tools' || args.at(-1) !== '') {
      throw new LLMError(
        'Refusing to call Claude Code: `--tools ""` must be the final argument pair, ' +
          'otherwise the variadic flag can swallow following arguments and tools stay enabled.',
        this.name,
      );
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Cheap local invariant first, then the one-time subprocess contract check.
    const args = this.buildArgs(req);
    this.assertToolsFlagIsLast(args);
    await this.verifyToolSuppressionSupported();

    const startedAt = Date.now();
    const raw = await this.run(args, req.userMessage, req.timeoutMs);
    const durationMs = Date.now() - startedAt;

    let envelope: z.infer<typeof CliEnvelope>;
    try {
      envelope = CliEnvelope.parse(JSON.parse(raw));
    } catch (cause) {
      throw new LLMError(
        'Claude Code returned output that was not the expected JSON envelope',
        this.name,
        {
          cause,
        },
      );
    }

    if (envelope.is_error) {
      throw new LLMError(
        `Claude Code reported an error (${envelope.subtype ?? 'unknown'})`,
        this.name,
      );
    }
    if (envelope.structured_output === undefined) {
      throw new LLMError(
        'Claude Code returned no structured_output — the model answered in prose instead of the schema',
        this.name,
      );
    }

    this.assertNoToolsWereUsed(envelope);

    // Model and provider are logged; auth material never is.
    this.log.info(
      {
        provider: this.name,
        model: this.model,
        durationMs,
        costUsd: envelope.total_cost_usd,
        sessionId: envelope.session_id,
        status: 'ok',
      },
      'claude-code interpretation returned',
    );

    return {
      data: envelope.structured_output,
      meta: {
        provider: this.name,
        model: this.model,
        durationMs,
        ...(envelope.total_cost_usd === undefined ? {} : { costUsd: envelope.total_cost_usd }),
        ...(envelope.session_id === undefined ? {} : { sessionId: envelope.session_id }),
      },
    };
  }

  /**
   * Second layer: evidence in the response that a tool ran anyway. A denial means
   * something attempted a tool call; a server-tool count means one actually ran.
   * Either way the suppression contract is broken, so we discard the result rather
   * than return data produced with capabilities StandSync never granted.
   */
  private assertNoToolsWereUsed(envelope: z.infer<typeof CliEnvelope>): void {
    const denials = envelope.permission_denials?.length ?? 0;
    const webSearches = envelope.usage?.server_tool_use?.web_search_requests ?? 0;
    const webFetches = envelope.usage?.server_tool_use?.web_fetch_requests ?? 0;

    if (denials === 0 && webSearches === 0 && webFetches === 0) return;

    this.log.error(
      { provider: this.name, denials, webSearches, webFetches, status: 'tools_used' },
      'Claude Code used or attempted tools during interpretation — discarding the result',
    );
    throw new LLMError(
      `Refusing the interpretation: tools were active during the call ` +
        `(${denials} permission denial(s), ${webSearches} web search(es), ${webFetches} web fetch(es)). ` +
        `Standup interpretation must run with no tool access.`,
      this.name,
    );
  }

  /**
   * First layer, run once per client: confirm the installed CLI still documents
   * `--tools <tools...>` with the empty-string-disables-everything semantics.
   * If the contract has changed, fail closed rather than assume tools are off.
   */
  private verifyToolSuppressionSupported(): Promise<void> {
    // Memoize the *success* only. Caching the promise unconditionally would let a
    // single transient failure — a spawn hiccup under load, a momentary timeout —
    // poison the client for the lifetime of the process, so every later standup
    // would fall back to `unclear` even though the CLI had recovered. Clearing the
    // slot on rejection keeps the check fail-closed for this call while allowing
    // the next one to retry.
    this.toolContractCheck ??= this.checkToolContract().catch((err: unknown) => {
      this.toolContractCheck = undefined;
      throw err;
    });
    return this.toolContractCheck;
  }

  private async checkToolContract(): Promise<void> {
    let help: string;
    try {
      help = await this.run(['--help'], '', 15_000);
    } catch (cause) {
      throw new LLMError(
        `Could not verify the Claude Code CLI tool-suppression contract via --help. ` +
          `Refusing to run rather than risk interpreting a standup with tools enabled.`,
        this.name,
        { cause },
      );
    }

    const variadic = TOOLS_FLAG_SIGNATURE.test(help);
    const emptyDisables = TOOLS_EMPTY_DISABLES.test(help);
    if (variadic && emptyDisables) {
      this.log.debug(
        { provider: this.name, status: 'tool_contract_ok' },
        'Claude Code --tools contract verified',
      );
      return;
    }

    throw new LLMError(
      `The installed Claude Code CLI no longer documents the tool-suppression contract ` +
        `StandSync relies on (variadic --tools: ${variadic}, '""' disables all tools: ${emptyDisables}). ` +
        `Refusing to run so interpretation cannot silently gain filesystem, Bash, MCP or web access. ` +
        `Set LLM_PROVIDER=mock to continue without a model.`,
      this.name,
    );
  }

  /** Spawns the CLI, writes the prompt to stdin, and enforces the timeout. */
  private run(args: string[], stdinContent: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        shell: false, // no shell: untrusted content can never be interpreted as a command
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env, // inherited so the CLI finds the existing login / OAuth token
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));

      child.on('error', (err) => {
        finish(() =>
          reject(
            new LLMError(
              `Could not run the Claude Code CLI ("${this.cliPath}"). Is it installed and on PATH?`,
              this.name,
              { cause: err },
            ),
          ),
        );
      });

      child.on('close', (code) => {
        if (timedOut) {
          this.log.warn(
            { provider: this.name, model: this.model, timeoutMs, status: 'timeout' },
            'claude-code call timed out and was killed',
          );
          finish(() => reject(new LLMTimeoutError(this.name, timeoutMs)));
          return;
        }
        if (code !== 0) {
          finish(() =>
            reject(
              new LLMError(
                `Claude Code exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
                this.name,
              ),
            ),
          );
          return;
        }
        finish(() => resolve(stdout));
      });

      // The standup text goes here — over stdin, never as an argument.
      child.stdin.on('error', () => {
        /* the child may exit before we finish writing; close() handles the outcome */
      });
      child.stdin.end(stdinContent, 'utf8');
    });
  }
}

/**
 * Kills the CLI and anything it spawned. `child.kill()` alone can leave the real
 * worker running on Windows, which would hold the timeout open.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {
      /* best effort */
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
