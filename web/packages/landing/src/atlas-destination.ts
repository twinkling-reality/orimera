/** The deployment-owned boundary between the public landing page and the canonical Atlas app. */

export interface AtlasDestinationInput {
  readonly configured: string | undefined;
  readonly development: boolean;
  readonly landingHref: string;
}

function webDestination(value: string, base: string): URL | null {
  try {
    const destination = new URL(value, base);
    return destination.protocol === 'http:' || destination.protocol === 'https:' ? destination : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an Atlas URL without inventing a production topology.
 *
 * A deployment must provide `VITE_ATLAS_URL`; it may be absolute or relative to the landing page.
 * Development keeps one documented local default so a clean checkout has a usable handoff.
 */
export function resolveAtlasDestination(input: AtlasDestinationInput): URL | null {
  const configured = input.configured?.trim();
  if (configured !== undefined && configured !== '') {
    return webDestination(configured, input.landingHref);
  }
  if (!input.development) return null;
  return webDestination('http://127.0.0.1:5173/?preview=1', input.landingHref);
}

export function atlasDestinationFromEnvironment(landingHref: string): URL | null {
  return resolveAtlasDestination({
    configured: import.meta.env.VITE_ATLAS_URL,
    development: import.meta.env.DEV,
    landingHref,
  });
}
