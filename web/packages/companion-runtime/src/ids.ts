/**
 * Deterministic id generation.
 *
 * Turn ids, option ids, draft ids and proposal ids are all generated inside this package. They
 * are sequential and seeded rather than random for one reason: the option pool is the thing most
 * worth testing (that is why this package is headless), and a test that cannot name the option
 * it is asserting about is not much of a test.
 *
 * Nothing here is a security token. The proposal id's job is to be present in the pending set in
 * `graph-client`'s gate, not to be unguessable: the gate is an in-process invariant, not an
 * authorization boundary.
 */

export type IdFactory = (kind: string) => string;

export function sequentialIds(prefix = ''): IdFactory {
  const counters = new Map<string, number>();
  return (kind: string): string => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${prefix}${kind}-${next}`;
  };
}
