import { describe, it, expect } from 'vitest';
import { detectSkillShape, heuristicResponse, MockLLMClient } from '../src/llm/mock.js';
import { detectStandupSkill, ClassifyOutputSchema } from '../src/skills/detect-standup.js';
import { interpretWorkSkill, InterpretWorkOutputSchema } from '../src/skills/interpret-work.js';
import {
  validateProposalSkill,
  ValidateProposalOutputSchema,
} from '../src/skills/validate-proposal.js';
import {
  detectAmbiguitySkill,
  DetectAmbiguityOutputSchema,
} from '../src/skills/detect-ambiguity.js';
import { detectBlockersSkill, DetectBlockersOutputSchema } from '../src/skills/detect-blockers.js';
import { summarizeTeamSkill, SummarizeTeamOutputSchema } from '../src/skills/summarize-team.js';
import { INTERPRETATION_JSON_SCHEMA } from '../src/standup/prompts.js';
import type { LLMRequest } from '../src/llm/types.js';

/**
 * The offline demo provider.
 *
 * `LLM_PROVIDER=mock` is how StandSync stays demonstrable with no model at all,
 * and V1 relied on it. V2 has six prompts rather than one, so the unscripted
 * fallback has to answer each stage in that stage's own schema — otherwise every
 * V2 stage fails validation, the pipeline correctly treats it as an outage, and
 * the offline demo silently degrades to "nothing selected".
 *
 * These tests pin the routing and, more importantly, assert that each answer
 * validates against the real skill schema.
 */

const request = (
  skill: { jsonSchema: Record<string, unknown> },
  userMessage: string,
): LLMRequest => ({
  systemPrompt: 'unused',
  userMessage,
  jsonSchema: skill.jsonSchema,
  timeoutMs: 1_000,
});

const STANDUP =
  'Finished TES-41. TES-43 is blocked waiting for API access. Starting TES-42.\n\n' +
  'report on exactly these 3 ticket(s): TES-41, TES-43, TES-42';

describe('detectSkillShape', () => {
  it('identifies each V2 skill from its schema alone', () => {
    expect(detectSkillShape(detectStandupSkill.jsonSchema)).toBe('classify');
    expect(detectSkillShape(interpretWorkSkill.jsonSchema)).toBe('interpret');
    expect(detectSkillShape(validateProposalSkill.jsonSchema)).toBe('validate');
    expect(detectSkillShape(detectAmbiguitySkill.jsonSchema)).toBe('ambiguity');
    expect(detectSkillShape(detectBlockersSkill.jsonSchema)).toBe('blockers');
    expect(detectSkillShape(summarizeTeamSkill.jsonSchema)).toBe('summary');
  });

  it('distinguishes interpret from ambiguity, which both return `tickets`', () => {
    // The discriminator is the item shape, not the top-level property.
    expect(detectSkillShape(interpretWorkSkill.jsonSchema)).toBe('interpret');
    expect(detectSkillShape(detectAmbiguitySkill.jsonSchema)).toBe('ambiguity');
  });

  it('still recognises the V1 interpretation schema', () => {
    expect(detectSkillShape(INTERPRETATION_JSON_SCHEMA)).toBe('interpret');
  });

  it('falls back to unknown for an unrecognised schema', () => {
    expect(detectSkillShape({ type: 'object', properties: { weather: {} } })).toBe('unknown');
    expect(detectSkillShape({ type: 'object' })).toBe('unknown');
  });
});

describe('heuristicResponse answers in the caller’s schema', () => {
  it('produces a valid classification', () => {
    const parsed = ClassifyOutputSchema.safeParse(
      heuristicResponse(request(detectStandupSkill, 'Finished TES-41 today.')),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.relevant).toBe(true);
  });

  it('classifies chatter as irrelevant', () => {
    const parsed = ClassifyOutputSchema.safeParse(
      heuristicResponse(request(detectStandupSkill, 'Anyone going for lunch?')),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.relevant).toBe(false);
      expect(parsed.data.type).toBe('unrelated');
    }
  });

  it('produces a valid interpretation covering the mentioned keys', () => {
    const parsed = InterpretWorkOutputSchema.safeParse(
      heuristicResponse(request(interpretWorkSkill, STANDUP)),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tickets.map((t) => t.key).sort()).toEqual(['TES-41', 'TES-42', 'TES-43']);
    }
  });

  it('produces a valid validation verdict per key', () => {
    const parsed = ValidateProposalOutputSchema.safeParse(
      heuristicResponse(request(validateProposalSkill, STANDUP)),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.valid).toBe(true);
      expect(parsed.data.changes.map((c) => c.key)).toContain('TES-41');
    }
  });

  it('produces a valid, non-ambiguous verdict per key', () => {
    const parsed = DetectAmbiguityOutputSchema.safeParse(
      heuristicResponse(request(detectAmbiguitySkill, STANDUP)),
    );
    expect(parsed.success).toBe(true);
    // Offline mode must not manufacture questions it cannot reason about.
    if (parsed.success) expect(parsed.data.tickets.every((t) => !t.ambiguous)).toBe(true);
  });

  it('produces valid blockers, derived from the same keyword sets', () => {
    const parsed = DetectBlockersOutputSchema.safeParse(
      heuristicResponse(request(detectBlockersSkill, STANDUP)),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const blocked = parsed.data.blockers.filter((b) => b.blocked);
    expect(blocked.map((b) => b.key)).toEqual(['TES-43']);
    expect(blocked[0]?.description).toContain('API access');

    // The other two keys are reported explicitly as not blocked.
    expect(parsed.data.blockers).toHaveLength(3);
  });

  it('produces a valid summary that names only supplied keys', () => {
    const parsed = SummarizeTeamOutputSchema.safeParse(
      heuristicResponse(request(summarizeTeamSkill, STANDUP)),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const named = [...parsed.data.completed, ...parsed.data.inProgress, ...parsed.data.blocked];
      for (const line of named) expect(STANDUP).toContain(line.key);
    }
  });

  it('reads the explicit key list in preference to scanning the whole prompt', () => {
    // A prompt that mentions a ticket only as context must not be reported on.
    const prompt =
      'Work update:\n"""\nFinished TES-41.\n"""\n\n' +
      'report on exactly these 1 ticket(s): TES-41\n\n' +
      'Earlier messages in this thread, for context only:\n- Chandima: what about TES-99?';

    const parsed = DetectBlockersOutputSchema.safeParse(
      heuristicResponse(request(detectBlockersSkill, prompt)),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.blockers.map((b) => b.key)).toEqual(['TES-41']);
  });
});

describe('MockLLMClient routing', () => {
  it('routes an unscripted call by schema', async () => {
    const llm = new MockLLMClient();

    const classification = await llm.complete(request(detectStandupSkill, 'Finished TES-41.'));
    expect(ClassifyOutputSchema.safeParse(classification.data).success).toBe(true);

    const validation = await llm.complete(request(validateProposalSkill, STANDUP));
    expect(ValidateProposalOutputSchema.safeParse(validation.data).success).toBe(true);
  });

  it('a script still wins over the heuristics, so tests stay exact', async () => {
    const llm = MockLLMClient.returning({ anything: 'at all' });
    const response = await llm.complete(request(detectStandupSkill, 'Finished TES-41.'));
    expect(response.data).toEqual({ anything: 'at all' });
  });

  it('records every request for assertions', async () => {
    const llm = new MockLLMClient();
    await llm.complete(request(interpretWorkSkill, STANDUP));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.jsonSchema).toBe(interpretWorkSkill.jsonSchema);
  });
});
