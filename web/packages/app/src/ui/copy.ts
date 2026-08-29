/**
 * The words. This is the only file in the workspace that authors user-facing prose.
 *
 * `atlas-core`, `companion-runtime` and `world-index` all emit message KEYS and refuse to write
 * sentences, and their docstrings say why: `companion-runtime`'s phrasing seam hands a model
 * keys and no consequences, and `atlas-core`'s rung labels record that the exact copy is OPEN in
 * `product-specification.md` P-2 while the constraint is fixed. Keeping the copy out of those
 * packages is what lets a wording change be a wording change rather than a behaviour change.
 *
 * The consequence is that somebody has to own the table, and it is this file.
 *
 * **An unmapped key renders as the key, visibly.** Not as a blank, and not as a plausible
 * fallback sentence generated from the key's own words. A blank hides a missing string, and a
 * generated sentence is prose nobody reviewed appearing in a product whose whole claim is that
 * its sentences are backed. A key on the screen is ugly and findable, which is the correct
 * trade.
 *
 * **One rule constrains the wording rather than taste.** `product-specification.md` 5.2: no
 * label may imply free movement in a region that does not have it, and no copy anywhere may say
 * private, on-device, encrypted, immutable, WORM, tamper-proof or regulatory-compliant. The rung
 * strings below are written against that and `copyIsHonest` asserts it in a test rather than
 * leaving it to review.
 */

/** Words no copy in this product may contain, whatever the sentence around them. */
export const FORBIDDEN_WORDS: readonly string[] = Object.freeze([
  'private',
  'on-device',
  'encrypted',
  'end-to-end',
  'immutable',
  'worm',
  'tamper-proof',
  'compliant',
]);

const COPY: Readonly<Record<string, string>> = Object.freeze({
  // Provenance rows. Band 1 renders the user's verbatim words when it has them; these are the
  // labels for a row that has none.
  'row.name': 'Name',
  'row.nameScope': 'Where that name applies',
  'row.note': 'Note',
  'row.relation': 'Relation',
  'row.sameEntityAs': 'The same as',
  'row.notThisClass': 'Not this kind of thing',
  'row.uncertain': 'Uncertain',

  // Band 4. Each one is a question the system is holding open, not an error.
  'unknown.name': 'Nobody has said what this is called.',
  'unknown.nameScope': 'It is not settled whether that name applies everywhere.',
  'unknown.relation': 'Nothing is recorded about how this relates to anything else.',
  'unknown.contradiction': 'Something recorded here contradicts something else recorded here.',
  'unknown.whenFirstSeen': 'It is not known when this was first seen.',
  'unknown.nothingOpen': 'Nothing about this is outstanding.',

  'method.unknown': 'method not recorded',
  'external.asOf': 'as of',
  'placeholder.unnamed': 'Unnamed',

  // What a proposal would do. Written from the operation, never from a model.
  'provenance.userEditedName': 'You are naming this.',
  'provenance.userMergedEntities': 'You are saying these are one thing.',
  'provenance.userSplitEntity': 'You are saying these are not one thing.',
  'provenance.userDeletedEntity': 'You are removing this from the index.',
  // The exact distinction that makes delete honest: the index entry goes, the photographs do not.
  'delete.originalMediaIsNotDeleted':
    'The original photographs are not deleted. Only what the index knows about them is.',

  // Empty states. Which zero it is, in words.
  'index.noMatches': 'Nothing here matches that.',
  'review.nothingNeedsAttention': 'Nothing needs attention.',

  // Why a control is present and not available. The reason is the information.
  'unavailable.mergedAway': 'This was merged into something else.',
  'unavailable.nothingToReview': 'There is nothing waiting for an answer here.',
  'unavailable.nothingToSplit': 'There is only one occurrence, so there is nothing to split off.',
  'unavailable.outOfMvpCut': 'This instance does not do that yet.',

  // The reconstruction ladder. Rung 1 is the only one permitted to imply free movement.
  'rung.1': 'Photoreal region. You can move freely inside it.',
  'rung.2': 'Recovered along the path the camera travelled. Movement follows that path.',
  'rung.3': 'Photographic panels with a little depth. Movement is between them.',
  'rung.4': 'No geometry was reconstructed. Evidence is laid out by time and by what it shares.',
});

/** The sentence for a key, or the key itself when nobody has written one. */
export function say(key: string): string {
  return COPY[key] ?? key;
}

/** Every key that has a sentence. Exported so a test can walk the whole table. */
export function everyPhrase(): readonly (readonly [string, string])[] {
  return Object.entries(COPY);
}
