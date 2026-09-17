import type { Proposal, ProposalAction, RiskLevel } from '../types.js';
import { isPresent, type IssueContextResult } from '../jira/context.js';

/**
 * Skill: write the one-line reason shown under each proposed change.
 *
 * This is the one reasoning module in V2 that is deliberately NOT a model call.
 * Everything a good explanation needs is already established fact by this point:
 * who said it, the phrase they used (the interpreter returned it as `evidence`),
 * the ticket's real current status, and whether the destination is a transition
 * Jira actually offers. Composing those is both cheaper and strictly more
 * truthful than asking a model to restate them, and it cannot invent a reason
 * for a change it did not understand.
 *
 * The style rules are the point of the module: name the person, quote their
 * words, state the Jira fact. No "it appears that", no "the AI has determined",
 * no hedging adverbs.
 */

export interface ExplainProposalInput {
  authorName: string;
  actions: ProposalAction[];
  /** The phrase from the message that supports this reading. */
  evidence: string;
  context: IssueContextResult | undefined;
  /** Validator output, when the validation stage ran. */
  validation?: {
    valid: boolean;
    risk: RiskLevel;
    warnings: string[];
    explanation: string;
  };
  /** True when confidence fell below the auto-select threshold. */
  lowConfidence: boolean;
}

export interface ExplainProposalOutput {
  /** One or two factual sentences for the card. */
  reason: string;
  /** "In Progress → Code Review", or "No status change". */
  change: string;
}

/** Renders the status line for a proposal: what would happen to the ticket. */
export function describeChange(actions: ProposalAction[]): string {
  const transition = actions.find((a) => a.type === 'transition');
  const comment = actions.find((a) => a.type === 'comment');
  const none = actions.find((a) => a.type === 'none');

  if (transition?.type === 'transition') {
    const suffix = comment ? ' · comment' : '';
    return `${transition.fromStatus} → ${transition.toStatus}${suffix}`;
  }
  if (comment) return 'No status change · comment';
  if (none?.type === 'none') return 'No action';
  return 'No action';
}

/**
 * Builds the explanation.
 *
 * Order matters: the author's own words first, because that is what the approver
 * is checking; then the Jira fact that makes the change possible or impossible;
 * then any caution. The validator's sentence is preferred over ours when it
 * exists, because it was written against Jira state rather than the sentence
 * alone — but a generic-sounding one is dropped rather than shown.
 */
export function explainProposal(input: ExplainProposalInput): ExplainProposalOutput {
  const change = describeChange(input.actions);
  const parts: string[] = [];

  const quote = input.evidence.trim().replace(/^["'\s]+|["'\s]+$/g, '');
  const transition = input.actions.find((a) => a.type === 'transition');

  if (quote) {
    parts.push(`${input.authorName} said "${quote}".`);
  }

  if (transition?.type === 'transition') {
    parts.push(`${transition.toStatus} is an available next transition in Jira.`);
  } else if (isPresent(input.context)) {
    const none = input.actions.find((a) => a.type === 'none');
    if (none?.type === 'none') {
      parts.push(`${input.context.key} stays ${input.context.status}: ${lowerFirst(none.reason)}`);
    } else if (input.actions.some((a) => a.type === 'comment')) {
      parts.push(`${input.context.key} stays ${input.context.status}; only a comment is proposed.`);
    }
  }

  const validatorSentence = input.validation?.explanation.trim();
  if (validatorSentence && !isGeneric(validatorSentence)) {
    parts.push(ensureSentence(validatorSentence));
  }

  for (const warning of input.validation?.warnings ?? []) {
    const trimmed = warning.trim();
    if (trimmed) parts.push(ensureSentence(trimmed));
  }

  if (input.lowConfidence) {
    parts.push('Lower confidence — check before approving.');
  }

  return { reason: parts.join(' ').trim() || 'No action needed.', change };
}

/**
 * Filters out the filler a model produces when it has nothing to add. Showing
 * "The proposed change appears to be appropriate." is worse than showing
 * nothing, because it spends the approver's attention on zero information.
 */
const GENERIC_PHRASES = [
  'as an ai',
  'appears to be appropriate',
  'appears appropriate',
  'seems appropriate',
  'seems reasonable',
  'looks reasonable',
  'no issues found',
  'no concerns',
  'this is a valid change',
  'the change is valid',
  'i believe',
  'it appears that',
];

export function isGeneric(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return GENERIC_PHRASES.some((phrase) => lower.includes(phrase));
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  // Keep an initial Jira key or acronym upper case: "PAY-1 is..." not "pAY-1 is...".
  if (/^[A-Z]{2,}/.test(trimmed)) return ensureSentence(trimmed);
  return ensureSentence(trimmed.charAt(0).toLowerCase() + trimmed.slice(1));
}

/** The card-ready view of one proposal: key, change, reason, confidence badge. */
export interface ProposalSummary {
  key: string;
  change: string;
  reason: string;
  confidenceLabel: string;
  risk?: RiskLevel;
  verified: boolean;
  warnings: string[];
}

/** Confidence as a word. A percentage implies precision the number does not have. */
export function confidenceWord(confidence: number): string {
  if (confidence >= 0.8) return 'High';
  if (confidence >= 0.5) return 'Medium';
  if (confidence > 0) return 'Low';
  return 'Unknown';
}

export function summarizeProposal(proposal: Proposal): ProposalSummary {
  return {
    key: proposal.key,
    change: describeChange(proposal.actions),
    reason: proposal.explanation,
    confidenceLabel: confidenceWord(proposal.confidence),
    ...(proposal.review?.risk ? { risk: proposal.review.risk } : {}),
    verified: proposal.review?.transitionVerified === true,
    warnings: proposal.review?.warnings ?? [],
  };
}
