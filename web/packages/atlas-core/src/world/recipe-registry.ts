import type { ReconstructionRung } from '../rung.js';
import { WorldModuleRegistry } from './module-registry.js';

export interface WorldRecipeAttachment {
  readonly parentSlot: string;
  readonly socket: string;
}

export interface WorldRecipeSlot {
  /** Stable within the recipe. Instance identity is derived from this key, never array order. */
  readonly key: string;
  readonly moduleKey: string;
  readonly attachTo: WorldRecipeAttachment | null;
  readonly required: boolean;
}

export interface WorldRecipeDefinition {
  readonly key: string;
  readonly version: number;
  readonly scope: 'world' | 'region' | 'relationship';
  readonly allowedRungs: 'any' | readonly ReconstructionRung[];
  readonly slots: readonly WorldRecipeSlot[];
}

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Validated declarative DAG. Recipes describe assemblies; they do not execute engine code. */
export class WorldRecipeRegistry {
  readonly version: number;
  readonly recipes: readonly WorldRecipeDefinition[];
  readonly #byKey: ReadonlyMap<string, WorldRecipeDefinition>;

  constructor(
    version: number,
    recipes: readonly WorldRecipeDefinition[],
    modules: WorldModuleRegistry,
  ) {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError('recipe catalog version must be a positive safe integer');
    }
    const byKey = new Map<string, WorldRecipeDefinition>();
    for (const source of recipes) {
      if (!KEY.test(source.key)) throw new TypeError(`invalid recipe key: ${source.key}`);
      if (!Number.isSafeInteger(source.version) || source.version < 1) {
        throw new TypeError(`invalid recipe version: ${source.key}`);
      }
      if (byKey.has(source.key)) throw new TypeError(`duplicate recipe key: ${source.key}`);
      const slotKeys = new Set<string>();
      for (const slot of source.slots) {
        if (!KEY.test(slot.key)) throw new TypeError(`invalid slot key on ${source.key}: ${slot.key}`);
        if (slotKeys.has(slot.key)) {
          throw new TypeError(`duplicate slot ${slot.key} on recipe ${source.key}`);
        }
        if (!modules.has(slot.moduleKey)) {
          throw new TypeError(`recipe ${source.key} uses unknown module ${slot.moduleKey}`);
        }
        if (slot.attachTo !== null) {
          if (!slotKeys.has(slot.attachTo.parentSlot)) {
            throw new TypeError(
              `recipe ${source.key} slot ${slot.key} attaches to a missing or later parent ${slot.attachTo.parentSlot}`,
            );
          }
          const parent = source.slots.find((candidate) => candidate.key === slot.attachTo!.parentSlot)!;
          modules.assertAttachment(parent.moduleKey, slot.attachTo.socket, slot.moduleKey);
        }
        slotKeys.add(slot.key);
      }
      if (source.slots.length === 0) throw new TypeError(`recipe has no slots: ${source.key}`);
      if (source.allowedRungs !== 'any' && new Set(source.allowedRungs).size !== source.allowedRungs.length) {
        throw new TypeError(`recipe repeats an allowed rung: ${source.key}`);
      }
      const recipe = Object.freeze({
        ...source,
        allowedRungs:
          source.allowedRungs === 'any'
            ? 'any'
            : Object.freeze([...source.allowedRungs]),
        slots: Object.freeze(source.slots.map((slot) => Object.freeze({
          ...slot,
          attachTo: slot.attachTo === null ? null : Object.freeze({ ...slot.attachTo }),
        }))),
      });
      byKey.set(recipe.key, recipe);
    }
    this.version = version;
    this.recipes = Object.freeze([...byKey.values()]);
    this.#byKey = byKey;
    Object.freeze(this);
  }

  get(key: string): WorldRecipeDefinition {
    const found = this.#byKey.get(key);
    if (found === undefined) throw new TypeError(`unknown world recipe: ${key}`);
    return found;
  }
}

