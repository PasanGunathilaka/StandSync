import type { Config } from '../config.js';
import { isFromBot } from './channelGuard.js';

/**
 * Ambient ingress filtering: the cheap, deterministic decisions about whether a
 * Teams message is even a candidate for the pipeline.
 *
 * Everything here runs before any model call, and everything is a pure function
 * so the rules are testable without a Teams connection — the same approach
 * src/teams/channelGuard.ts takes for the channel allow-list.
 *
 * The distinction this file exists to enforce: StandSync *receives* every
 * message in an observed channel and *reacts to* almost none of them. A bot that
 * answers "good morning" is a bot a team mutes.
 */

/** Why a message was dropped before reasoning. */
export type AmbientVerdict =
  | { process: true; reason: 'mention' | 'ambient_candidate' }
  | { process: false; reason: AmbientRejection; detail?: string };

export type AmbientRejection =
  | 'from_bot'
  | 'not_allowed_conversation'
  | 'ambient_disabled'
  | 'system_activity'
  | 'empty'
  | 'social_chatter'
  | 'duplicate';

/** The parts of a Teams activity ambient filtering needs. */
export interface AmbientActivity {
  id: string;
  conversationId: string;
  /** replyToId — present when the message is inside a thread. */
  threadId?: string;
  authorId: string;
  authorName?: string;
  authorRole?: string;
  /** Cleaned text: mentions and HTML already stripped. */
  text: string;
  /** True when the activity mentioned StandSync. */
  mentionsBot: boolean;
  /** Card actions, typing indicators, system events. */
  isSystemActivity?: boolean;
  /** Present when the activity carried attachments (e.g. an Adaptive Card). */
  hasCardAttachment?: boolean;
}

/**
 * Conversations ambient mode may observe: the primary allow-listed channel plus
 * any explicitly listed extras.
 *
 * There is intentionally no wildcard. Ambient listening is granted per
 * conversation, so adding the app to a new channel cannot silently start
 * feeding that channel's messages into a Jira-mutating pipeline.
 */
export function ambientConversations(config: Config): string[] {
  const ids = [
    config.TEAMS_ALLOWED_CONVERSATION_ID.trim(),
    ...config.STANDSYNC_AMBIENT_CONVERSATION_IDS,
  ].filter(Boolean);
  return [...new Set(ids)];
}

export function isAmbientConversation(conversationId: string, config: Config): boolean {
  return ambientConversations(config).includes(conversationId);
}

/**
 * Social chatter that is definitely not a work update.
 *
 * These patterns are deliberately conservative: they only fire on messages that
 * are *entirely* a greeting, an acknowledgement or an emoji. "Thanks — I
 * finished TES-31" must reach the classifier, so anything containing a Jira key
 * or more than a short phrase is left for the model to judge. A cheap filter
 * that occasionally passes a greeting through costs one classifier call; one
 * that eats a real standup costs a missing Jira update.
 */
const GREETINGS =
  /^(good\s+(morning|afternoon|evening|night)|morning|afternoon|evening|hi|hey|hello|hiya|yo|sup|greetings)\b/i;

const ACKNOWLEDGEMENTS =
  /^(thanks|thank\s+you|thx|ty|ok|okay|k|kk|cool|nice|great|awesome|perfect|sure|yep|yeah|yes|no|nope|got\s+it|noted|sounds\s+good|will\s+do|np|no\s+problem|welcome|cheers|lol|haha|same|agreed|\+1)\b/i;

/**
 * Emoji, punctuation and whitespace only.
 *
 * Written as a repeated alternation rather than one character class: emoji are
 * frequently multi-code-point (a ZWJ sequence, a skin-tone modifier, a
 * variation selector), and a character class matches code points individually,
 * which silently mis-handles them.
 */
const NON_TEXT_ONLY =
  /^(?:\s|\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{P}|\p{S}|‍|️|[\u{1F3FB}-\u{1F3FF}])+$/u;

/** Words that make a short message worth classifying even if it opens like chatter. */
const WORK_SIGNAL =
  /\b(finish|finished|complet|done|start|started|starting|resum|block|blocked|waiting|review|deploy|merg|ship|fix|fixed|test|wip|progress|pick(ed|ing)?\s+up|ticket|issue|pr\b|bug)/i;

const JIRA_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![0-9])/;

/**
 * Whether a message is obvious chatter. Only used to skip the classifier call —
 * never to decide that relevant-looking text is irrelevant.
 */
export function isObviousChatter(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Anything naming a ticket or a work verb goes to the classifier, always.
  if (JIRA_KEY.test(trimmed) || WORK_SIGNAL.test(trimmed)) return false;

  if (NON_TEXT_ONLY.test(trimmed)) return true;

  // Only judge short messages. A long message that happens to start with "hi"
  // is a message, not a greeting.
  const words = trimmed.split(/\s+/);
  if (words.length > 8) return false;

  const stripped = trimmed.replace(/[\p{P}\p{S}\s]+$/u, '');
  return GREETINGS.test(stripped) || ACKNOWLEDGEMENTS.test(stripped);
}

/**
 * A message whose Jira key plus work verb make it a fast-path candidate.
 *
 * Used to skip the classifier when the answer is not in doubt: "Finished
 * TES-31." needs no model call to establish that it is a work update. This only
 * ever *admits* a message — the interpreter still decides what it means.
 */
export function isFastPathCandidate(text: string): boolean {
  return JIRA_KEY.test(text) && WORK_SIGNAL.test(text);
}

/**
 * The full ingress decision, before any model call.
 *
 * Order is deliberate: identity and configuration first (cheapest and most
 * security-relevant), then shape, then content. Deduplication is not here — it
 * needs storage, so the orchestrator performs it once this returns `process`.
 */
export function classifyIngress(activity: AmbientActivity, config: Config): AmbientVerdict {
  // 1. Never react to our own messages, another bot's, or a card update. Uses
  //    the same V1 check the mention path uses, rather than a second copy of it.
  if (
    isFromBot(
      { id: activity.authorId, ...(activity.authorRole ? { role: activity.authorRole } : {}) },
      config.MICROSOFT_APP_ID,
    )
  ) {
    return { process: false, reason: 'from_bot' };
  }
  if (activity.isSystemActivity) {
    return { process: false, reason: 'system_activity' };
  }
  // A message that is only an Adaptive Card is StandSync's own output echoed
  // back, or another app's card. Either way there is no standup in it.
  if (activity.hasCardAttachment && !activity.text.trim()) {
    return { process: false, reason: 'system_activity', detail: 'card attachment with no text' };
  }

  if (!activity.text.trim()) {
    return { process: false, reason: 'empty' };
  }

  // 2. A direct mention is always processed — that is V1 behaviour, and it must
  //    keep working whether or not ambient mode is on.
  if (activity.mentionsBot) {
    return { process: true, reason: 'mention' };
  }

  // 3. Beyond this point we are considering a message nobody addressed to us.
  if (!config.STANDSYNC_AMBIENT_MODE) {
    return { process: false, reason: 'ambient_disabled' };
  }
  if (!isAmbientConversation(activity.conversationId, config)) {
    return { process: false, reason: 'not_allowed_conversation' };
  }

  // 4. Cheap content filter, so ordinary chatter costs nothing.
  if (isObviousChatter(activity.text)) {
    return { process: false, reason: 'social_chatter' };
  }

  return { process: true, reason: 'ambient_candidate' };
}
