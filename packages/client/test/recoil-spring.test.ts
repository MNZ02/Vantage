import { describe, expect, it } from "vitest";
import { createRecoilSpring, kickRecoilSpring, stepRecoilSpring } from "../src/viewmodel.js";

describe("viewmodel recoil spring (M5 acceptance criterion 3: settles within 500ms simulated)", () => {
  it("returns to rest (near-zero offset and velocity) within 500ms after a kick, simulated at 144fps", () => {
    const spring = createRecoilSpring();
    kickRecoilSpring(spring, 7); // a rifle-class kick, per viewmodel.ts's fireKick()
    const dt = 1 / 144;
    const steps = Math.ceil(0.5 / dt);
    for (let i = 0; i < steps; i++) {
      stepRecoilSpring(spring, dt);
    }
    expect(Math.abs(spring.offset)).toBeLessThan(1e-3);
    expect(Math.abs(spring.velocity)).toBeLessThan(1e-2);
  });

  it("a bigger kick (sniper-class) also settles within 500ms", () => {
    const spring = createRecoilSpring();
    kickRecoilSpring(spring, 14);
    const dt = 1 / 60;
    const steps = Math.ceil(0.5 / dt);
    for (let i = 0; i < steps; i++) {
      stepRecoilSpring(spring, dt);
    }
    expect(Math.abs(spring.offset)).toBeLessThan(1e-2);
  });

  it("stays at rest with no kick", () => {
    const spring = createRecoilSpring();
    stepRecoilSpring(spring, 1 / 60);
    expect(spring.offset).toBe(0);
    expect(spring.velocity).toBe(0);
  });
});
