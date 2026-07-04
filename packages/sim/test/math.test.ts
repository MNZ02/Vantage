import { describe, expect, it } from "vitest";
import { atan2Approx, cosApprox, sinApprox } from "../src/math.js";

// The ban on Math.sin/cos/atan2 applies to sim/src; using them here as the
// reference oracle for the approximations is explicitly allowed by the spec.

describe("sinApprox / cosApprox", () => {
  it("matches Math.sin/Math.cos within 1e-4 across a wide sweep, including negatives and >2pi", () => {
    const N = 12000;
    let maxSinErr = 0;
    let maxCosErr = 0;
    for (let i = 0; i < N; i++) {
      // sweep roughly across [-20, 20], well beyond +/- 2*PI in both directions
      const x = -20 + (40 * i) / (N - 1);
      const sinErr = Math.abs(sinApprox(x) - Math.sin(x));
      const cosErr = Math.abs(cosApprox(x) - Math.cos(x));
      maxSinErr = Math.max(maxSinErr, sinErr);
      maxCosErr = Math.max(maxCosErr, cosErr);
    }
    expect(maxSinErr).toBeLessThan(1e-4);
    expect(maxCosErr).toBeLessThan(1e-4);
  });
});

describe("atan2Approx", () => {
  it("matches Math.atan2 within 1e-4 across a wide sweep of (y, x) pairs", () => {
    const N = 120;
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      const y = -10 + (20 * i) / (N - 1);
      for (let j = 0; j < N; j++) {
        const x = -10 + (20 * j) / (N - 1);
        const err = Math.abs(atan2Approx(y, x) - Math.atan2(y, x));
        maxErr = Math.max(maxErr, err);
      }
    }
    expect(maxErr).toBeLessThan(1e-4);
  });

  it("handles the axis and origin special cases", () => {
    expect(atan2Approx(0, 0)).toBe(0);
    expect(Math.abs(atan2Approx(1, 0) - Math.PI / 2)).toBeLessThan(1e-6);
    expect(Math.abs(atan2Approx(-1, 0) + Math.PI / 2)).toBeLessThan(1e-6);
  });
});
