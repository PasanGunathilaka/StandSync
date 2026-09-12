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

export interface Proposal {
  id: string; // uuid
  key: string;
  actions: ProposalAction[];
  confidence: number;
  explanation: string;
  selected: boolean; // for Review mode
}

export type BatchStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'partial';

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
}

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
