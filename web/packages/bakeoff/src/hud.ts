import type { RendererCapabilities } from '@orimera/atlas-three';
import type { RunResult } from './harness.js';

export const HUD_CSS = `
.hud { position: absolute; top: 14px; left: 14px; z-index: 5; max-width: 520px;
  padding: 12px 14px; border-radius: 10px; pointer-events: auto;
  background: rgba(10,12,17,0.86); border: 1px solid rgba(150,175,215,0.22);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #dae3f0; }
.hud h1 { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; letter-spacing: 0.03em;
  color: #f0f4fa; font-family: ui-sans-serif, system-ui, sans-serif; }
.hud .path { color: #8fb4e8; }
.hud .warn { color: #f0b46a; }
.hud .note { margin-top: 8px; color: rgba(200,214,235,0.62); font-size: 11px;
  font-family: ui-sans-serif, system-ui, sans-serif; }
.hud table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.hud th, .hud td { padding: 2px 7px 2px 0; text-align: right; white-space: nowrap; }
.hud th:first-child, .hud td:first-child { text-align: left; }
.hud th { color: rgba(200,214,235,0.6); font-weight: 500;
  border-bottom: 1px solid rgba(150,175,215,0.2); }
.hud .live { margin-top: 6px; font-size: 15px; color: #f0f4fa; }
.hud .spoiled { color: #f08a6a; }
`;

export class Hud {
  readonly root = document.createElement('div');
  private readonly head = document.createElement('div');
  private readonly live = document.createElement('div');
  private readonly table = document.createElement('table');
  private readonly note = document.createElement('div');

  constructor(container: HTMLElement, capabilities: RendererCapabilities) {
    this.root.className = 'hud';
    const title = document.createElement('h1');
    title.textContent = 'ADR-0003 bake-off, three.js r185 + Spark 2.1.0';
    this.root.appendChild(title);

    // Which path we are on, stated first, because every number below is conditional on it.
    this.head.innerHTML =
      `<span class="path">${capabilities.path.toUpperCase()}</span> ` +
      `on ${capabilities.unmaskedRenderer}<br>` +
      `WebGPU adapter: <span class="${capabilities.webgpuAvailable ? 'warn' : ''}">` +
      `${capabilities.webgpuAvailable ? 'AVAILABLE and unused' : 'not available'}</span><br>` +
      `timer query: ${capabilities.timerQuery ? 'yes' : 'no'} &middot; ` +
      `JS heap API: ${capabilities.memoryApi ? 'yes' : 'no (numbers will read null)'}`;
    this.root.appendChild(this.head);

    this.live.className = 'live';
    this.root.appendChild(this.live);
    this.root.appendChild(this.table);

    this.note.className = 'note';
    this.note.textContent =
      'GPU memory is not readable from a web page. The bytes column is what this binding ' +
      'uploaded: a lower bound on VRAM, not a measurement of it.';
    this.root.appendChild(this.note);

    container.appendChild(this.root);
  }

  setPhase(phase: string, detail: string): void {
    this.live.textContent = `${phase}: ${detail}`;
  }

  setLive(fps: number, points: number, extra = ''): void {
    this.live.textContent = `${fps.toFixed(1)} fps  ${(points / 1e6).toFixed(2)}M points  ${extra}`;
  }

  render(results: readonly RunResult[]): void {
    const head =
      '<tr><th>rung</th><th>islands</th><th>total</th><th>fps</th><th>1% low</th>' +
      '<th>p95 ms</th><th>TTFR ms</th><th>heap MB</th><th>uploaded MB</th></tr>';
    const rows = results
      .map(
        (r) =>
          `<tr class="${r.spoiled ? 'spoiled' : ''}">` +
          `<td>${r.label}${r.spoiled ? ' !' : ''}</td>` +
          `<td>${r.islands}</td>` +
          `<td>${(r.pointsTotal / 1e6).toFixed(2)}M</td>` +
          `<td>${r.fpsMean.toFixed(1)}</td>` +
          `<td>${r.fpsP1Low.toFixed(1)}</td>` +
          `<td>${r.frameMsP95.toFixed(1)}</td>` +
          `<td>${r.timeToFirstRenderMs.toFixed(0)}</td>` +
          `<td>${r.heapPeakMb === null ? 'n/a' : r.heapPeakMb.toFixed(0)}</td>` +
          `<td>${(r.uploadedBytes / 1e6).toFixed(1)}</td>` +
          '</tr>',
      )
      .join('');
    this.table.innerHTML = head + rows;
  }
}
