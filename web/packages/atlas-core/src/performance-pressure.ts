import type { ResidencyStage } from './residency.js';

export interface PressureSample {
  readonly frameTimeMs: number;
  /** Measured resident bytes divided by the declared resource budget. Omit when unavailable. */
  readonly resourceRatio?: number;
}

export interface RepresentationPressureState {
  readonly level: 0 | 1 | 2 | 3;
  readonly maxStage: ResidencyStage;
  readonly budgetScale: number;
  readonly p95FrameTimeMs: number | null;
  readonly resourceRatio: number | null;
}

const STAGES: readonly ResidencyStage[] = ['full', 'coarse', 'proxy', 'stub'];
const SCALES = [1, 0.72, 0.45, 0.22] as const;

/**
 * A measurement-driven pressure controller. It accepts frame/resource observations only; it has
 * no device name, user agent, GPU model, screen class, or hardware allowlist to sniff.
 */
export class RepresentationPressureController {
  readonly #windowSize: number;
  readonly #frameBudgetMs: number;
  readonly #samples: PressureSample[] = [];
  #level: 0 | 1 | 2 | 3 = 0;
  #overloadedWindows = 0;
  #healthyWindows = 0;
  #state: RepresentationPressureState = Object.freeze({
    level: 0,
    maxStage: 'full',
    budgetScale: 1,
    p95FrameTimeMs: null,
    resourceRatio: null,
  });

  constructor(options: { readonly windowSize?: number; readonly frameBudgetMs?: number } = {}) {
    this.#windowSize = options.windowSize ?? 60;
    this.#frameBudgetMs = options.frameBudgetMs ?? 1000 / 60;
    if (!Number.isSafeInteger(this.#windowSize) || this.#windowSize < 4) {
      throw new RangeError('pressure window size must be a safe integer of at least four');
    }
    if (!Number.isFinite(this.#frameBudgetMs) || this.#frameBudgetMs <= 0) {
      throw new RangeError('frame budget must be finite and positive');
    }
  }

  get state(): RepresentationPressureState {
    return this.#state;
  }

  record(sample: PressureSample): { readonly changed: boolean; readonly state: RepresentationPressureState } {
    if (!Number.isFinite(sample.frameTimeMs) || sample.frameTimeMs <= 0) {
      throw new RangeError('frame time must be finite and positive');
    }
    if (
      sample.resourceRatio !== undefined &&
      (!Number.isFinite(sample.resourceRatio) || sample.resourceRatio < 0)
    ) {
      throw new RangeError('resource ratio must be finite and non-negative');
    }
    this.#samples.push(Object.freeze({ ...sample }));
    if (this.#samples.length < this.#windowSize) return { changed: false, state: this.#state };

    const ordered = this.#samples.map((value) => value.frameTimeMs).sort((a, b) => a - b);
    const p95 = ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]!;
    const ratios = this.#samples.flatMap((value) =>
      value.resourceRatio === undefined ? [] : [value.resourceRatio]);
    const ratio = ratios.length === 0 ? null : Math.max(...ratios);
    this.#samples.length = 0;

    const overloaded = p95 > this.#frameBudgetMs * 1.25 || (ratio !== null && ratio > 0.92);
    const healthy = p95 < this.#frameBudgetMs * 0.92 && (ratio === null || ratio < 0.72);
    this.#overloadedWindows = overloaded ? this.#overloadedWindows + 1 : 0;
    this.#healthyWindows = healthy ? this.#healthyWindows + 1 : 0;
    const before = this.#level;
    if (this.#overloadedWindows >= 2 && this.#level < 3) {
      this.#level = (this.#level + 1) as 1 | 2 | 3;
      this.#overloadedWindows = 0;
      this.#healthyWindows = 0;
    } else if (this.#healthyWindows >= 5 && this.#level > 0) {
      this.#level = (this.#level - 1) as 0 | 1 | 2;
      this.#overloadedWindows = 0;
      this.#healthyWindows = 0;
    }
    this.#state = Object.freeze({
      level: this.#level,
      maxStage: STAGES[this.#level]!,
      budgetScale: SCALES[this.#level]!,
      p95FrameTimeMs: p95,
      resourceRatio: ratio,
    });
    return { changed: before !== this.#level, state: this.#state };
  }
}
