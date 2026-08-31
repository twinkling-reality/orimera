import { describe, expect, it, vi } from 'vitest';
import { WorldStyleProposalInbox } from '../src/world-style-proposals.js';

const proposal = {
  origin: 'companion' as const,
  originReference: 'companion-world-design',
  profile: { profileId: 'origin-landscape', profileVersion: 1 },
  referenceIds: ['span-1'],
  modelId: 'reviewed-personalizer-v1',
  promptVersion: 'world-style-v1',
};

describe('upstream world style proposal inbox', () => {
  it('delivers structured proposals without inventing a conversational service', () => {
    const inbox = new WorldStyleProposalInbox();
    const listener = vi.fn();
    const unsubscribe = inbox.subscribe(listener);
    expect(inbox.submit(proposal)).toBe(true);
    expect(listener).toHaveBeenCalledWith(proposal);
    unsubscribe();
    expect(inbox.submit(proposal)).toBe(false);
  });
});
