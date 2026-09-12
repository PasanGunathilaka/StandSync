import Anthropic from '@anthropic-ai/sdk';
import { logger, type Logger } from '../logger.js';
import { TOOL_NAME } from '../standup/prompts.js';
import {
  LLMError,
  LLMTimeoutError,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

/**
 * Direct Anthropic API provider. Kept for future use — the competition build runs
 * on `claude-code`, which needs no API key.
 *
 * Structured output is forced via tool use: a single tool whose input_schema is the
 * interpretation schema, with tool_choice pinned to it, so the model cannot reply
 * in prose. Requires ANTHROPIC_API_KEY.
 */
export interface AnthropicOptions {
  apiKey: string;
  model: string;
  log?: Logger;
  /** Injectable for tests. */
  client?: Anthropic;
}

export class AnthropicLLMClient implements LLMClient {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly log: Logger;

  constructor(opts: AnthropicOptions) {
    if (!opts.apiKey && !opts.client) {
      throw new LLMError(
        'LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use LLM_PROVIDER=claude-code to ' +
          'authenticate with your Claude Code subscription instead.',
        'anthropic',
      );
    }
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.log = opts.log ?? logger;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: req.systemPrompt,
          messages: [{ role: 'user', content: req.userMessage }],
          tools: [
            {
              name: TOOL_NAME,
              description: 'Report the interpreted intent for each Jira ticket in the standup.',
              input_schema: req.jsonSchema as Anthropic.Tool.InputSchema,
            },
          ],
          // Forces a schema-shaped tool call rather than free text.
          tool_choice: { type: 'tool', name: TOOL_NAME },
        },
        { timeout: req.timeoutMs },
      );
    } catch (cause) {
      if (cause instanceof Anthropic.APIConnectionTimeoutError) {
        throw new LLMTimeoutError(this.name, req.timeoutMs);
      }
      throw new LLMError(
        `Anthropic API call failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.name,
        { cause },
      );
    }

    const durationMs = Date.now() - startedAt;
    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      throw new LLMError('Anthropic response contained no tool_use block', this.name);
    }

    this.log.info(
      { provider: this.name, model: this.model, durationMs, status: 'ok' },
      'anthropic interpretation returned',
    );

    return {
      data: toolUse.input,
      meta: { provider: this.name, model: this.model, durationMs },
    };
  }
}
