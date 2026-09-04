// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { CAPABILITY_GROUPS, buildCapabilities } from '../src/ui/capabilities.js';
import { buildManifesto } from '../src/ui/manifesto.js';

describe('the signed-out informational pages', () => {
  it('keeps the Manifesto a semantic page of convictions rather than a status inventory', () => {
    const manifesto = buildManifesto();

    expect(manifesto.id).toBe('manifesto');
    expect(manifesto.getAttribute('aria-labelledby')).toBe('manifesto-title');
    expect(manifesto.querySelector('h1')?.textContent).toBe('Manifesto');
    expect(Array.from(manifesto.querySelectorAll('h2'), (node) => node.textContent)).toEqual([
      'Evidence comes before geometry',
      'An inference is not a fact',
      'Every place should show what it earned',
      'Uncertainty is allowed to remain',
      'Operational limits belong in the product',
    ]);
    expect(manifesto.textContent).not.toContain('Built and tested');
    expect(manifesto.textContent).not.toContain('Planned');
  });

  it('publishes an explicit, bounded status taxonomy on Capabilities', () => {
    const capabilities = buildCapabilities();

    expect(capabilities.id).toBe('capabilities');
    expect(capabilities.getAttribute('aria-labelledby')).toBe('capabilities-title');
    expect(capabilities.querySelector('h1')?.textContent).toBe('Capabilities');
    expect(CAPABILITY_GROUPS.map((group) => group.status)).toEqual([
      'Built and tested',
      'Built, real-world validation pending',
      'Planned',
      'Not deployed',
    ]);
    expect(Array.from(capabilities.querySelectorAll('h2'), (node) => node.textContent)).toEqual(
      CAPABILITY_GROUPS.map((group) => group.status),
    );
    expect(capabilities.textContent).toContain('not a hosted product');
    expect(capabilities.textContent).toContain('No user-authorized personal library');
  });

  it('keeps Atlas as the name of the navigable product space', () => {
    const text = `${buildManifesto().textContent} ${buildCapabilities().textContent}`;

    expect(text).toContain('Atlas');
    expect(text).not.toContain('Enter World');
  });
});
