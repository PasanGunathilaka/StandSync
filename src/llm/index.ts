import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import { AnthropicLLMClient } from './anthropic.js';
import { ClaudeCodeLLMClient } from './claudeCode.js';
import { MockLLMClient } from './mock.js';
import type { LLMClient } from './types.js';

export { ClaudeCodeLLMClient } from './claudeCode.js';
export { AnthropicLLMClient } from './anthropic.js';
export { MockLLMClient, heuristicInterpretation } from './mock.js';
export * from './types.js';

/**
 * Builds the configured provider. All three satisfy LLMClient, so nothing
 * downstream of this function knows which one is in play.
 */
export function createLLMClient(config: Config, log: Logger = logger): LLMClient {
  switch (config.LLM_PROVIDER) {
    case 'claude-code': {
      log.info(
        { provider: 'claude-code', model: config.ANTHROPIC_MODEL },
        'using Claude Code CLI (subscription login / CLAUDE_CODE_OAUTH_TOKEN; no API key)',
      );
      return new ClaudeCodeLLMClient({
        model: config.ANTHROPIC_MODEL,
        cliPath: config.CLAUDE_CODE_PATH,
        log,
      });
    }
    case 'anthropic': {
      log.info({ provider: 'anthropic', model: config.ANTHROPIC_MODEL }, 'using Anthropic SDK');
      return new AnthropicLLMClient({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
        log,
      });
    }
    case 'mock': {
      log.warn(
        { provider: 'mock' },
        'using deterministic mock interpretation — no model is being called',
      );
      return new MockLLMClient();
    }
  }
}
