import { afterEach, describe, expect, it } from "vitest";
import {
  isBuyMenuAvailable,
  isBuyMenuOpen,
  isInterfaceOverlayOpen,
  getPitch,
  getYaw,
  setBuyMenuAvailable,
  setBuyMenuOpen,
  setInterfaceOverlayOpen,
  setLookAngles,
} from "../src/input.js";

afterEach(() => {
  setInterfaceOverlayOpen(false);
  setInterfaceOverlayOpen(false, "settings");
  setInterfaceOverlayOpen(false, "agent-select");
  setBuyMenuAvailable(false);
});

describe("authoritative buy-menu availability", () => {
  it("cannot open while the current match phase disallows buying", () => {
    setBuyMenuAvailable(false);
    setBuyMenuOpen(true);

    expect(isBuyMenuAvailable()).toBe(false);
    expect(isBuyMenuOpen()).toBe(false);
  });

  it("closes immediately when the buy phase ends", () => {
    setBuyMenuAvailable(true);
    setBuyMenuOpen(true);
    expect(isBuyMenuOpen()).toBe(true);

    setBuyMenuAvailable(false);

    expect(isBuyMenuOpen()).toBe(false);
  });

  it("closes the shop and blocks reopening while another modal owns input", () => {
    setBuyMenuAvailable(true);
    setBuyMenuOpen(true);
    expect(isBuyMenuOpen()).toBe(true);

    setInterfaceOverlayOpen(true);
    setBuyMenuOpen(true);

    expect(isInterfaceOverlayOpen()).toBe(true);
    expect(isBuyMenuOpen()).toBe(false);
  });

  it("keeps gameplay suppressed until every modal owner closes", () => {
    setInterfaceOverlayOpen(true, "settings");
    setInterfaceOverlayOpen(true, "agent-select");

    setInterfaceOverlayOpen(false, "settings");
    expect(isInterfaceOverlayOpen()).toBe(true);

    setInterfaceOverlayOpen(false, "agent-select");
    expect(isInterfaceOverlayOpen()).toBe(false);
  });
});

describe("authoritative look synchronisation", () => {
  it("applies spawn yaw and clamps invalidly steep pitch", () => {
    setLookAngles(Math.PI, Math.PI);
    expect(getYaw()).toBe(Math.PI);
    expect(getPitch()).toBeLessThan(Math.PI / 2);
    setLookAngles(0, 0);
  });
});
