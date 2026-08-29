import { describe, expect, it } from 'vitest';
import { BAND_ORDER } from '@orimera/companion-runtime';
import { rungProperties } from '@orimera/atlas-core';

import { FORBIDDEN_WORDS, everyPhrase, say } from '../src/ui/copy.js';

/**
 * The copy table, checked against the two rules the product actually fixes.
 *
 * `product-specification.md` 7 excludes any claim of private, on-device, encrypted, immutable,
 * WORM, tamper-proof or regulatory-compliant storage, and section 5.2 fixes that no label may
 * imply free movement in a region that does not have it. Both are review gates today. A review
 * gate is a person remembering; these are the same rules as assertions.
 */

describe('the copy this product is allowed to use', () => {
  it('contains none of the claims the product cannot back', () => {
    for (const [key, sentence] of everyPhrase()) {
      const lower = sentence.toLowerCase();
      for (const word of FORBIDDEN_WORDS) {
        expect(lower.includes(word), `${key} says "${word}"`).toBe(false);
      }
    }
  });

  it('never implies free movement in a rung that does not have it', () => {
    // The one fixed constraint in 5.2. `impliesFreeMovement` is the flag atlas-core carries for
    // exactly this assertion, so the test reads the flag rather than a list written twice.
    for (const rung of [1, 2, 3, 4] as const) {
      const properties = rungProperties(rung);
      const sentence = say(properties.labelKey).toLowerCase();
      if (properties.impliesFreeMovement) continue;
      expect(sentence.includes('freely'), `${properties.labelKey} implies free movement`).toBe(
        false,
      );
      expect(sentence.includes('anywhere'), `${properties.labelKey} implies free movement`).toBe(
        false,
      );
    }
  });

  it('has a sentence for every rung on the ladder', () => {
    for (const rung of [1, 2, 3, 4] as const) {
      const key = rungProperties(rung).labelKey;
      expect(say(key), `${key} has no sentence`).not.toBe(key);
    }
  });

  it('has a sentence for every band the confirmation panel can hold open', () => {
    // Band 4 is never omitted, so every key it can carry needs words. A missing one renders as
    // the key, which is findable but is not something anybody should read.
    for (const band of BAND_ORDER) {
      expect(BAND_ORDER).toContain(band);
    }
    for (const key of [
      'unknown.name',
      'unknown.nameScope',
      'unknown.relation',
      'unknown.contradiction',
      'unknown.whenFirstSeen',
      'unknown.nothingOpen',
    ]) {
      expect(say(key), `${key} has no sentence`).not.toBe(key);
    }
  });

  it('renders an unwritten key as the key, so a missing string is visible rather than blank', () => {
    expect(say('nobody.wrote.this')).toBe('nobody.wrote.this');
  });
});
