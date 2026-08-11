import { describe, expect, it } from "vitest";
import { createState, defaultInput, serializeState, tick, type Box, type InputFrame } from "../src/index.js";

const boxes: Box[] = [
  { minX: -50, minY: -1, minZ: -50, maxX: 50, maxY: 0, maxZ: 50 }, // floor
  { minX: 3, minY: 0, minZ: -1, maxX: 4, maxY: 3, maxZ: 1 }, // a wall to run into
];

// A deterministic (not random) but non-trivial scripted input: varies forward/
// strafe/yaw/jump/crouch as a function of tick index only, so two independent
// runs fed the same sequence must produce identical results if tick() is pure.
function scriptedInput(t: number): InputFrame {
  const yaw = t * 0.003;
  return {
    forward: Math.sin(t * 0.05),
    right: Math.cos(t * 0.07) * 0.5,
    yaw,
    pitch: Math.sin(t * 0.011) * 0.2,
    jump: t % 97 === 0,
    crouch: t % 150 < 40,
    walk: t % 200 < 30,
    fire: t % 61 === 0,
    ads: t % 83 === 0,
    reload: t % 173 < 3,
    slot1: t % 211 === 0,
    slot2: t % 233 === 0,
  };
}

function runTicks(seed: number, count: number): string[] {
  let state = createState(seed, 1);
  const snapshots: string[] = [];
  for (let t = 0; t < count; t++) {
    state = tick(state, [scriptedInput(t)], boxes).state;
    if ((t + 1) % 500 === 0) {
      snapshots.push(serializeState(state));
    }
  }
  return snapshots;
}

describe("determinism", () => {
  it("stores cloned ECS columns in one backing allocation without aliasing the prior state", () => {
    const initial = createState(7, 2);
    const next = tick(initial, [defaultInput(), defaultInput()], []).state;
    const buffers = new Set(
      Object.values(next)
        .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
        .map((view) => view.buffer),
    );
    expect(buffers.size).toBe(1);
    next.posX[0] = 12;
    expect(initial.posX[0]).toBe(0);
  });
  it("produces byte-identical serialized states for two runs of the same seed + input script", () => {
    const a = runTicks(12345, 2000);
    const b = runTicks(12345, 2000);
    expect(a.length).toBe(4);
    expect(a).toEqual(b);
  });

  it("does not mutate the input state object passed to tick()", () => {
    const boxesLocal: Box[] = boxes;
    const state0 = createState(42, 1);
    const before = serializeState(state0);
    tick(state0, [scriptedInput(0)], boxesLocal);
    expect(serializeState(state0)).toBe(before);
  });
});
