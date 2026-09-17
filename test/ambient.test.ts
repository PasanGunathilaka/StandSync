import { describe, it, expect } from 'vitest';
import {
  ambientConversations,
  classifyIngress,
  isAmbientConversation,
  isFastPathCandidate,
  isObviousChatter,
  type AmbientActivity,
} from '../src/teams/ambient.js';
import { loadConfig, type Config } from '../src/config.js';

/**
 * Ambient ingress: what StandSync will and will not even consider.
 *
 * The property under test throughout is that receiving a message and reacting
 * to one are different things. Every case here happens before any model call.
 */

const BASE_ENV = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'token',
};

const configWith = (over: Record<string, string> = {}): Config =>
  loadConfig({ ...BASE_ENV, ...over });

const activity = (over: Partial<AmbientActivity> = {}): AmbientActivity => ({
  id: 'msg-1',
  conversationId: 'conv-allowed',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  text: 'Finished TES-31 today.',
  mentionsBot: false,
  ...over,
});

const AMBIENT_ON = {
  STANDSYNC_AMBIENT_MODE: 'true',
  TEAMS_ALLOWED_CONVERSATION_ID: 'conv-allowed',
};

describe('ambient conversation allow-list', () => {
  it('includes the primary channel without extra configuration', () => {
    const config = configWith({ TEAMS_ALLOWED_CONVERSATION_ID: 'conv-a' });
    expect(ambientConversations(config)).toEqual(['conv-a']);
    expect(isAmbientConversation('conv-a', config)).toBe(true);
  });

  it('adds explicitly listed extra conversations', () => {
    const config = configWith({
      TEAMS_ALLOWED_CONVERSATION_ID: 'conv-a',
      STANDSYNC_AMBIENT_CONVERSATION_IDS: 'conv-b, conv-c',
    });
    expect(ambientConversations(config)).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });

  it('de-duplicates a conversation listed twice', () => {
    const config = configWith({
      TEAMS_ALLOWED_CONVERSATION_ID: 'conv-a',
      STANDSYNC_AMBIENT_CONVERSATION_IDS: 'conv-a,conv-b',
    });
    expect(ambientConversations(config)).toEqual(['conv-a', 'conv-b']);
  });

  it('has no wildcard — an unlisted conversation is never ambient', () => {
    const config = configWith({
      TEAMS_ALLOWED_CONVERSATION_ID: 'conv-a',
      STANDSYNC_AMBIENT_CONVERSATION_IDS: '*',
    });
    // '*' is treated as a literal id, not a wildcard.
    expect(isAmbientConversation('conv-anything', config)).toBe(false);
  });

  it('is empty when nothing is configured, so nothing is observed', () => {
    expect(ambientConversations(configWith())).toEqual([]);
  });
});

describe('obvious chatter (the pre-classifier filter)', () => {
  it.each([
    'Good morning',
    'good morning guys',
    'morning all!',
    'hi team',
    'Hello',
    'thanks',
    'Thanks!',
    'thank you',
    'ok',
    'sounds good',
    'noted',
    'cheers',
    '+1',
    '👍',
    '🎉🎉🎉',
    '👍🏽',
    '👨‍💻',
    '...',
    '   ',
  ])('treats %j as chatter', (text) => {
    expect(isObviousChatter(text)).toBe(true);
  });

  it.each([
    'Finished TES-31 today.',
    'TES-42 is blocked waiting for API credentials.',
    'Started working on the payment ticket.',
    // Opens like an acknowledgement but reports work — must reach the classifier.
    'thanks — I finished TES-31',
    'ok so I picked up the invoice work this morning',
    'Code is done, just needs review',
    // Long enough that an opening greeting does not define it.
    'morning all, yesterday I wrapped up the payment validation and today I am on invoices',
  ])('does not treat %j as chatter', (text) => {
    expect(isObviousChatter(text)).toBe(false);
  });

  it('never eats a message containing a Jira key', () => {
    // Even something that looks like pure acknowledgement.
    expect(isObviousChatter('ok TES-31')).toBe(false);
  });
});

describe('fast path (skips the classifier call)', () => {
  it('admits a Jira key plus a work verb', () => {
    expect(isFastPathCandidate('Finished TES-31 today.')).toBe(true);
    expect(isFastPathCandidate('TES-42 is blocked waiting for credentials')).toBe(true);
  });

  it('does not admit a bare ticket mention with no work verb', () => {
    expect(isFastPathCandidate('has anyone seen TES-31?')).toBe(false);
  });

  it('does not admit a work verb with no ticket', () => {
    expect(isFastPathCandidate('I finished the thing')).toBe(false);
  });
});

describe('classifyIngress — identity and system activities', () => {
  const config = configWith(AMBIENT_ON);

  it('ignores StandSync’s own messages by app id', () => {
    const withAppId = configWith({ ...AMBIENT_ON, MICROSOFT_APP_ID: 'app-1' });
    const verdict = classifyIngress(activity({ authorId: '28:app-1' }), withAppId);
    expect(verdict).toEqual({ process: false, reason: 'from_bot' });
  });

  it('ignores any bot by role', () => {
    const verdict = classifyIngress(activity({ authorRole: 'bot' }), config);
    expect(verdict).toEqual({ process: false, reason: 'from_bot' });
  });

  it('ignores system activities', () => {
    const verdict = classifyIngress(activity({ isSystemActivity: true }), config);
    expect(verdict).toEqual({ process: false, reason: 'system_activity' });
  });

  it('ignores a bare Adaptive Card update with no text', () => {
    const verdict = classifyIngress(activity({ text: '', hasCardAttachment: true }), config);
    expect(verdict.process).toBe(false);
    if (!verdict.process) expect(verdict.reason).toBe('system_activity');
  });

  it('ignores an empty message', () => {
    expect(classifyIngress(activity({ text: '   ' }), config).process).toBe(false);
  });

  it('checks identity before content, so a bot posting a standup is still ignored', () => {
    const verdict = classifyIngress(
      activity({ authorRole: 'bot', text: 'Finished TES-31' }),
      config,
    );
    expect(verdict).toEqual({ process: false, reason: 'from_bot' });
  });
});

describe('classifyIngress — ambient mode off preserves V1 behaviour', () => {
  const config = configWith({ TEAMS_ALLOWED_CONVERSATION_ID: 'conv-allowed' });

  it('processes a mention', () => {
    const verdict = classifyIngress(activity({ mentionsBot: true }), config);
    expect(verdict).toEqual({ process: true, reason: 'mention' });
  });

  it('ignores a message that did not mention the bot', () => {
    const verdict = classifyIngress(activity({ mentionsBot: false }), config);
    expect(verdict).toEqual({ process: false, reason: 'ambient_disabled' });
  });

  it('ignores an unmentioned work update even in the allow-listed channel', () => {
    const verdict = classifyIngress(
      activity({ text: 'Finished TES-31 today.', mentionsBot: false }),
      config,
    );
    expect(verdict.process).toBe(false);
  });
});

describe('classifyIngress — ambient mode on', () => {
  const config = configWith(AMBIENT_ON);

  it('processes a work update with no mention', () => {
    const verdict = classifyIngress(activity({ text: 'Finished TES-31 today.' }), config);
    expect(verdict).toEqual({ process: true, reason: 'ambient_candidate' });
  });

  it('still processes a mention, and labels it as one', () => {
    const verdict = classifyIngress(activity({ mentionsBot: true }), config);
    expect(verdict).toEqual({ process: true, reason: 'mention' });
  });

  it('ignores an unconfigured conversation', () => {
    const verdict = classifyIngress(activity({ conversationId: 'conv-other' }), config);
    expect(verdict).toEqual({ process: false, reason: 'not_allowed_conversation' });
  });

  it('ignores obvious chatter without a model call', () => {
    const verdict = classifyIngress(activity({ text: 'good morning guys' }), config);
    expect(verdict).toEqual({ process: false, reason: 'social_chatter' });
  });

  it('processes a mention from an unconfigured conversation only if allow-listed', () => {
    // A mention short-circuits the ambient checks, but createTeamsApp still
    // applies the V1 channel guard — this asserts the ingress contract only.
    const verdict = classifyIngress(
      activity({ conversationId: 'conv-other', mentionsBot: true }),
      config,
    );
    expect(verdict).toEqual({ process: true, reason: 'mention' });
  });

  it('observes an additionally configured conversation', () => {
    const wider = configWith({
      ...AMBIENT_ON,
      STANDSYNC_AMBIENT_CONVERSATION_IDS: 'conv-second',
    });
    const verdict = classifyIngress(activity({ conversationId: 'conv-second' }), wider);
    expect(verdict).toEqual({ process: true, reason: 'ambient_candidate' });
  });
});
