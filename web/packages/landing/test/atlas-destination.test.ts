import { describe, expect, it } from 'vitest';

import { resolveAtlasDestination } from '../src/atlas-destination.js';

const landingHref = 'https://exulanica.example/welcome';

describe('the canonical Atlas handoff', () => {
  it('uses an absolute deployment destination exactly', () => {
    const destination = resolveAtlasDestination({
      configured: 'https://atlas.exulanica.example/session',
      development: false,
      landingHref,
    });
    expect(destination?.href).toBe('https://atlas.exulanica.example/session');
  });

  it('supports a same-origin deployment path', () => {
    const destination = resolveAtlasDestination({
      configured: '/atlas',
      development: false,
      landingHref,
    });
    expect(destination?.href).toBe('https://exulanica.example/atlas');
  });

  it('uses the documented app preview during local development', () => {
    const destination = resolveAtlasDestination({
      configured: undefined,
      development: true,
      landingHref: 'http://127.0.0.1:5174/',
    });
    expect(destination?.href).toBe('http://127.0.0.1:5173/?preview=1');
  });

  it('does not invent a production destination', () => {
    expect(
      resolveAtlasDestination({ configured: undefined, development: false, landingHref }),
    ).toBeNull();
  });

  it('rejects non-web destinations', () => {
    expect(
      resolveAtlasDestination({
        configured: 'javascript:alert(1)',
        development: false,
        landingHref,
      }),
    ).toBeNull();
  });
});
