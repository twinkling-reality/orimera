import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The split this package claims, asserted rather than trusted.
 *
 * Given the same events this package produces the same state, on any machine, with no network
 * and no document. That is what lets the labels be tested headless and what lets one contract
 * serve a scripted demonstration and a live pipeline.
 *
 * The property turned out to be stronger than the split it was written for. `http-source.ts`
 * knows the shape of a network protocol, but it reaches for no global either: its `fetch` is
 * injected, which is why a test of it needs a function returning bytes rather than a server. So
 * EVERY file here is checked, and the transport is asserted to take its transport in rather than
 * being exempted from the rule.
 *
 * The package's tsconfig carries `lib.dom` because the transport's types need it, which means
 * the compiler would accept `document` anywhere in here. This is the check the compiler cannot
 * make.
 */

const SRC = new URL('../src/', import.meta.url).pathname;

/** Every source file, barrel excluded: it only re-exports and has nothing of its own to check. */
const PURE = readdirSync(SRC).filter((name) => name.endsWith('.ts') && name !== 'index.ts');

/**
 * Patterns that mean a file REACHED for a browser global, rather than merely named one.
 *
 * `FormationEventSource` is a type in this package and `MockFormationEventSource` implements it,
 * so a bare search for `EventSource` matches the contract's own vocabulary. What is forbidden is
 * constructing one, which is what the pattern says.
 */
const REACHES_FOR: readonly (readonly [string, RegExp])[] = [
  ['document', /(?<![\w.])document\s*\./],
  ['window', /(?<![\w.])window\s*\./],
  ['localStorage', /(?<![\w.])localStorage\b/],
  ['sessionStorage', /(?<![\w.])sessionStorage\b/],
  ['fetch', /(?<![\w.])fetch\s*\(/],
  ['new EventSource', /new\s+EventSource\s*\(/],
  ['XMLHttpRequest', /(?<![\w.])XMLHttpRequest\b/],
];

describe('the formation contract stays pure', () => {
  it('has files to check', () => {
    // A test that walked an empty directory would pass while checking nothing, which is the
    // shape of failure this repository has already found twice.
    expect(PURE.length).toBeGreaterThan(3);
    expect(PURE).toContain('state.ts');
    expect(PURE).toContain('events.ts');
    expect(PURE).toContain('http-source.ts');
  });

  it.each(PURE)('%s reaches for no browser global', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    for (const [label, pattern] of REACHES_FOR) {
      expect(pattern.test(source), `${name} reaches for ${label}`).toBe(false);
    }
  });

  it('the transport takes its transport in rather than reaching for one', () => {
    // This is why the file above passes the global check despite being the one that talks to a
    // server. A transport that grabbed the global could not be tested without a network, and a
    // test that needs a network is one nobody runs.
    const transport = readFileSync(join(SRC, 'http-source.ts'), 'utf8');
    expect(transport).toContain('readonly fetch: StreamFetch');
    expect(transport).toContain('options.fetch(');
  });

  it.each(PURE)('%s holds no timer, so nothing advances between events', (name) => {
    // interaction-model.md 8.4: the visual freezes on stream loss. That is free rather than a
    // special case only because nothing in the reducer can advance on its own.
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source).not.toMatch(/\bsetInterval\b|\brequestAnimationFrame\b/);
  });
});
