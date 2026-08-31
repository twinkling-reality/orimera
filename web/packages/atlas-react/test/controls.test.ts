// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNavigationWorld, makeScene } from '@orimera/atlas-core';
import { FirstPersonControls } from '../src/playcanvas/controls.js';

describe('first-person keyboard ownership', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      writable: true,
      value: null,
    });
  });

  it('stops residual velocity as soon as pointer lock is released', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const controls = new FirstPersonControls(canvas, {
      x: 0,
      y: 1.62,
      z: 0,
      yaw: 0,
      pitch: 0,
    });
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: canvas,
      writable: true,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    controls.update(0.2);
    const movedZ = controls.state.z;
    expect(movedZ).toBeLessThan(0);

    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: null,
      writable: true,
    });
    document.dispatchEvent(new Event('pointerlockchange'));
    controls.update(0.2);
    expect(controls.state.z).toBe(movedZ);
    controls.destroy();
  });

  it('never swallows native button activation', () => {
    const canvas = document.createElement('canvas');
    const button = document.createElement('button');
    document.body.append(canvas, button);
    const controls = new FirstPersonControls(canvas, { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 });
    const interact = vi.fn();
    controls.onInteract = interact;

    const event = new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(interact).not.toHaveBeenCalled();
    controls.destroy();
  });

  it('does not summon behind a disabled system surface', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const controls = new FirstPersonControls(canvas, { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 });
    const summon = vi.fn();
    controls.onSummon = summon;
    controls.setEnabled(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x' }));
    expect(summon).not.toHaveBeenCalled();
    controls.destroy();
  });

  it('keeps WASD available without reclaiming pointer lock while answering', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const requestPointerLock = vi.fn();
    canvas.requestPointerLock = requestPointerLock;
    const controls = new FirstPersonControls(canvas, { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 });
    controls.setConversationActive(true);

    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    expect(requestPointerLock).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    controls.update(0.2);
    expect(controls.state.z).toBeLessThan(0);
    controls.destroy();
  });

  it('uses X as the one keyboard summon contract', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const controls = new FirstPersonControls(canvas, { x: 0, y: 1.62, z: 0, yaw: 0, pitch: 0 });
    const summon = vi.fn();
    controls.onSummon = summon;

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', key: 'c' }));
    expect(summon).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x' }));
    expect(summon).toHaveBeenCalledOnce();
    controls.destroy();
  });

  it('publishes recovery once after returning from outside the resident field', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const world = buildNavigationWorld(makeScene([], 1, 1));
    const controls = new FirstPersonControls(
      canvas,
      { x: 1_000, y: 1.62, z: 0, yaw: 0, pitch: 0 },
      undefined,
      world,
    );
    controls.update(0.016);
    expect(controls.consumeRecoveryReason()).toBe('outside-field');
    expect(controls.consumeRecoveryReason()).toBeNull();
    controls.destroy();
  });
});
