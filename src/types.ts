/**
 * Core StandSync domain types.
 *
 * Flow: Claude interprets (TicketInterpretation) -> StandSync merges with live Jira
 * state (JiraIssueState) -> Proposal[] -> human approves -> execute.
 * Claude never produces a Proposal directly and never touches Jira.
 */

export type Intent =
  'completed' | 'in_progress' | 'blocked' | 'not_done_yet' | 'no_change' | 'unclear';

export interface TicketInterpretation {
  key: string; // e.g. "PAY-142"
  intent: Intent;
  blockerReason?: string; // present when intent === 'blocked'
  commentText?: string; // suggested comment, if any
  confidence: number; // 0..1
  evidence: string; // the phrase from the message that supports this
}

export interface InterpretationResult {
  tickets: TicketInterpretation[];
  unresolvedMentions: string[]; // things that look like work but have no key
}

export interface JiraIssueState {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  transitions: { id: string; name: string; toStatus: string }[];
}

export type ProposalAction =
  | { type: 'transition'; fromStatus: string; toStatus: string; transitionId: string }
  | { type: 'comment'; body: string }
  | { type: 'none'; reason: string };

/** V2 risk grading, produced by the proposal validator. */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * V2 audit metadata attached to a proposal. Every field is optional so a V1
 * proposal (and a V1 row already in SQLite) stays a valid Proposal.
 *
 * Deliberately holds only concise conclusions — a verdict, a risk grade, short
 * warnings. No chain-of-thought is stored.
 */
export interface ProposalReview {
  /** Whether the validator agreed the action is justified by Jira state. */
  validated?: boolean;
  risk?: RiskLevel;
  /** Short, human-readable cautions shown on the card. */
  warnings?: string[];
  /** True when the transition was confirmed present in the live workflow. */
  transitionVerified?: boolean;
}

export interface Proposal {
  id: string; // uuid
  key: string;
  actions: ProposalAction[];
  confidence: number;
  explanation: string;
  selected: boolean; // for Review mode
  /** V2 only. Absent on V1 proposals. */
  review?: ProposalReview;
}

export type BatchStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'partial';

/**
 * V2 provenance for a batch: where the message came from and how the agent
 * stages graded it. Optional throughout, so V1 batches remain valid.
 */
export interface BatchOrigin {
  /** 'mention' = V1 directed message; 'ambient' = observed without @StandSync. */
  source?: 'mention' | 'ambient' | 'dev' | 'clarification';
  /** Teams thread (replyToId) when the message was part of one. */
  threadId?: string;
  /** What the relevance classifier concluded. */
  classification?: MessageKind;
  classifierConfidence?: number;
  /** Correlates every agent_runs row for this batch. */
  traceId?: string;
  /** The clarification this batch was produced from, if any. */
  clarificationId?: string;
}

export interface ProposalBatch {
  id: string;
  conversationId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  rawMessage: string;
  proposals: Proposal[];
  status: BatchStatus;
  createdAt: string;
  /** V2 only. Absent on V1 batches. */
  origin?: BatchOrigin;
}

/** What the relevance classifier decided an ambient message is. */
export type MessageKind =
  | 'standup_update'
  | 'work_update'
  | 'blocker'
  | 'jira_reference'
  | 'clarification_reply'
  | 'unrelated';

/** Outcome of applying one proposal's actions against Jira. */
export interface ExecutionResult {
  proposalId: string;
  key: string;
  ok: boolean;
  applied: string[]; // human-readable summaries of what actually landed
  error?: string;
}

/** Aggregate outcome of executing a batch. */
export interface BatchExecution {
  batchId: string;
  status: Extract<BatchStatus, 'executed' | 'failed' | 'partial' | 'rejected'>;
  results: ExecutionResult[];
}
