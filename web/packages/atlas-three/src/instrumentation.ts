/**
 * The measurement half of the bake-off, kept separate from the renderer so that turning it off
 * removes it entirely rather than leaving a disabled branch in the frame loop.
 *
 * WHAT IS HONEST HERE AND WHAT IS NOT, stated up front because the ADR turns on these numbers:
 *
 *   FRAME TIME is real. It is `requestAnimationFrame` delta, measured in the foreground.
 *   ADR-0003 already warns that "a hidden render pane throttles requestAnimationFrame and
 *   invalidates the numbers", so this class also records `document.visibilityState` transitions
 *   and marks any window that contained a hidden period as SPOILED. A spoiled number is
 *   reported as spoiled rather than dropped, because a silently discarded sample is how a
 *   benchmark ends up measuring only its good moments.
 *
 *   JS HEAP is Chrome-only, quantised, and does not include GPU memory. `performance.memory` is
 *   non-standard. Where it is absent the field is null and stays null; there is no fallback
 *   estimate, because an estimate here would be a number with a unit and no meaning.
 *
 *   GPU MEMORY IS NOT MEASURABLE FROM THE PAGE. No browser API reports it. What this reports
 *   instead is the exact byte count this binding uploaded (positions, colours, segments,
 *   textures), labelled as `uploadedBytes`, plus three.js's own `renderer.info.memory` counts.
 *   That is a lower bound on VRAM and it is labelled as one. Calling it "GPU memory" would be
 *   the single easiest place in this harness to publish a fabricated number.
 *
 *   TIME TO FIRST MEANINGFUL RENDER is measured to the first `requestAnimationFrame` callback
 *   that runs AFTER the first draw of the full point set has been submitted and the GPU has
 *   acknowledged it, using `WebGLRenderer.getContext().finish()` once on that frame. `finish`
 *   is a real synchronisation point, so the number includes shader compilation and the first
 *   buffer upload, which is what a user waiting for the world actually experiences.
 */

export interface FrameSample {
  readonly t: number;
  readonly dtMs: number;
}

export interface WindowStats {
  readonly frames: number;
  readonly fpsMean: number;
  readonly fpsP1Low: number;
  readonly frameMsMean: number;
  readonly frameMsP95: number;
  readonly frameMsMax: number;
  readonly spoiled: boolean;
}

export interface HeapReading {
  readonly usedMb: number | null;
  readonly limitMb: number | null;
  readonly available: boolean;
}

interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function readHeap(): HeapReading {
  const memory = (performance as unknown as { memory?: PerformanceMemory }).memory;
  if (memory === undefined) return { usedMb: null, limitMb: null, available: false };
  return {
    usedMb: memory.usedJSHeapSize / (1024 * 1024),
    limitMb: memory.jsHeapSizeLimit / (1024 * 1024),
    available: true,
  };
}

export class FrameMeter {
  private samples: number[] = [];
  private last = 0;
  private spoiled = false;

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.spoiled = true;
  };

  /** Call once per rAF. Returns the delta in seconds for the simulation. */
  tick(now: number): number {
    if (this.last === 0) {
      this.last = now;
      return 0;
    }
    const dt = now - this.last;
    this.last = now;
    this.samples.push(dt);
    return dt / 1000;
  }

  reset(): void {
    this.samples = [];
    this.spoiled = document.visibilityState !== 'visible';
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  summarise(): WindowStats {
    const s = [...this.samples].sort((a, b) => a - b);
    if (s.length === 0) {
      return {
        frames: 0,
        fpsMean: 0,
        fpsP1Low: 0,
        frameMsMean: 0,
        frameMsP95: 0,
        frameMsMax: 0,
        spoiled: this.spoiled,
      };
    }
    const total = s.reduce((a, b) => a + b, 0);
    const mean = total / s.length;
    const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    // "1% low" is reported as the mean of the slowest 1% of frames, which is the convention that
    // actually describes a stutter; the 99th percentile single frame does not.
    const lowCount = Math.max(1, Math.floor(s.length * 0.01));
    const lowSlice = s.slice(s.length - lowCount);
    const lowMean = lowSlice.reduce((a, b) => a + b, 0) / lowSlice.length;

    return {
      frames: s.length,
      fpsMean: 1000 / mean,
      fpsP1Low: 1000 / lowMean,
      frameMsMean: mean,
      frameMsP95: at(0.95),
      frameMsMax: s[s.length - 1]!,
      spoiled: this.spoiled,
    };
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
