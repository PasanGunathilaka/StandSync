import { describe, it, expect } from 'vitest';
import { extractKeys, projectKeyOf } from '../src/standup/extractKeys.js';

describe('extractKeys', () => {
  it('pulls keys out of the canonical demo standup, in mention order', () => {
    const text =
      'Yesterday I completed PAY-142. Today I am working on PAY-153. ' +
      'PAY-166 is blocked because I am waiting for API credentials.';
    expect(extractKeys(text)).toEqual(['PAY-142', 'PAY-153', 'PAY-166']);
  });

  it('deduplicates repeated mentions but keeps first-seen order', () => {
    expect(extractKeys('PAY-153 then PAY-142 and PAY-153 again')).toEqual(['PAY-153', 'PAY-142']);
  });

  it('handles multiple projects in one message', () => {
    expect(extractKeys('PAY-142 and OPS-7 plus AB1-99')).toEqual(['PAY-142', 'OPS-7', 'AB1-99']);
  });

  it('finds keys next to punctuation and inside Jira URLs', () => {
    expect(extractKeys('(PAY-142), [PAY-153]; "PAY-166"!')).toEqual([
      'PAY-142',
      'PAY-153',
      'PAY-166',
    ]);
    expect(extractKeys('see https://acme.atlassian.net/browse/PAY-142 for detail')).toEqual([
      'PAY-142',
    ]);
  });

  it('ignores lowercase prose that merely looks like a key', () => {
    expect(extractKeys('the api-2 spec and pay-142 are not keys')).toEqual([]);
  });

  it('requires at least two characters in the project part', () => {
    expect(extractKeys('A-1 is not a key but AB-1 is')).toEqual(['AB-1']);
  });

  it('treats a longer project prefix as its own key rather than a substring match', () => {
    // XPAY is a valid project key, so XPAY-142 is the key — not PAY-142 inside it.
    expect(extractKeys('XPAY-142')).toEqual(['XPAY-142']);
    // A digit before the project part means it is not a key at all.
    expect(extractKeys('9PAY-153')).toEqual([]);
  });

  it('does not truncate a longer issue number', () => {
    expect(extractKeys('PAY-1423 is the one')).toEqual(['PAY-1423']);
  });

  it('returns an empty list for messages with no keys', () => {
    expect(extractKeys('No ticket numbers here at all.')).toEqual([]);
    expect(extractKeys('')).toEqual([]);
  });
});

describe('projectKeyOf', () => {
  it('returns the project part of a key', () => {
    expect(projectKeyOf('PAY-142')).toBe('PAY');
    expect(projectKeyOf('TES-41')).toBe('TES');
    expect(projectKeyOf('BCPM-33')).toBe('BCPM');
  });

  it('handles a project key that itself contains digits', () => {
    expect(projectKeyOf('AB1-99')).toBe('AB1');
  });

  it('normalises to upper case', () => {
    expect(projectKeyOf('pay-142')).toBe('PAY');
  });
});
