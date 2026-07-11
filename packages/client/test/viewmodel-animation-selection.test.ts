import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { selectBestAnimationClip } from "../src/viewmodel.js";

describe("viewmodel animation clip selection", () => {
  it("prefers the matching duplicate with richer motion", () => {
    const translationOnly = new THREE.AnimationClip("reload", 1, [
      new THREE.VectorKeyframeTrack("root.position", [0, 1], [0, 0, 0, 0, -0.05, 0]),
      new THREE.QuaternionKeyframeTrack("hand.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const authoredRotation = new THREE.AnimationClip("reload.001", 1, [
      new THREE.VectorKeyframeTrack("root.position", [0, 1], [0, 0, 0, 0, -0.05, 0]),
      new THREE.QuaternionKeyframeTrack("hand.quaternion", [0, 1], [0, 0, 0, 1, 0.45, 0, 0, 0.89]),
    ]);

    expect(selectBestAnimationClip([translationOnly, authoredRotation], "reload")).toBe(authoredRotation);
  });

  it("does not mistake a quaternion sign flip for visible rotation", () => {
    const signFlippedIdentity = new THREE.AnimationClip("reload", 1, [
      new THREE.QuaternionKeyframeTrack("hand.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, -1]),
    ]);
    const halfAngle = 0.05;
    const actualRotation = new THREE.AnimationClip("reload.001", 1, [
      new THREE.QuaternionKeyframeTrack(
        "hand.quaternion",
        [0, 1],
        [0, 0, 0, 1, Math.sin(halfAngle), 0, 0, Math.cos(halfAngle)],
      ),
    ]);

    expect(selectBestAnimationClip([signFlippedIdentity, actualRotation], "reload")).toBe(actualRotation);
  });

  it("returns the exact clip when it is the only match", () => {
    const equip = new THREE.AnimationClip("equip", 0.5, []);
    const inspect = new THREE.AnimationClip("inspect", 1, []);

    expect(selectBestAnimationClip([equip, inspect], "equip")).toBe(equip);
    expect(selectBestAnimationClip([equip, inspect], "reload")).toBeUndefined();
  });
});
