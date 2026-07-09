// The graybox's shared collision+render data, plus (M5) the "level
// dressing" pass: non-colliding detail meshes, props, lights and skybox
// layered on top of the same LEVEL_BOXES collision geometry. Kept in this
// file per the M5 spec ("rename mentally to level dressing, keep the
// file") even though it now does a lot more than pick a flat color per box.
//
// Deliberately DOM-free: this file only ever imports "three" (whose core
// scene-graph/geometry math needs no canvas/WebGL) plus a *type-only* import
// of materials.ts's MaterialSet shape (erased at compile time, so it never
// actually pulls in materials.ts's `document.createElement("canvas")` calls
// at runtime). That's what keeps buildLevelDressing() unit-testable headlessly
// (see test/level-dressing-budget.test.ts, which passes in plain
// MeshBasicMaterials instead of the real canvas-textured ones).
import * as THREE from "three";
import {
  ATTACKER_SPAWNS,
  COVER_END,
  COVER_START,
  DEFENDER_SPAWNS,
  LEVEL_BOXES,
  LEVEL_HALF_EXTENT,
  PERIMETER_END,
  PERIMETER_START,
  SITE_LINE_Z,
  SITE_ZONES,
  SPAWN_POSITION as SIM_SPAWN_POSITION,
  WALLS_END,
  type Box,
} from "@vg/sim";
import { cloneModel, loadModel } from "./assets.js";
import type { MaterialSet } from "./materials.js";
import { PROPS, type PropSpec } from "./propPlacement.js";
import { classifyZone, type Zone } from "./zones.js";

/**
 * A collision box that also carries a render zone/color. Structurally a
 * `Box` (same minX..maxZ fields) built by zipping @vg/sim's `LEVEL_BOXES`
 * (the single source of truth for collision geometry, shared with
 * @vg/server) with a zone classification (position-derived, see zones.ts)
 * and a flat fallback tint — one source of truth for geometry, client-only
 * concerns (zone/color) layered on top (M0 spec acceptance criterion 8; M1
 * spec's shared-level-data requirement).
 */
export interface GrayboxSurface extends Box {
  color: number;
  zone: Zone;
}

/** Which base material "kind" a LEVEL_BOXES index uses — derived from the index ranges @vg/sim's levels.ts exports alongside the box array itself (floor/walls/cover/stairs), so this mapping can never drift when the layout changes. */
export type SurfaceKind = "floor" | "wall" | "crate" | "ramp";

export function surfaceKindForIndex(index: number): SurfaceKind {
  if (index === 0) return "floor";
  if (index >= PERIMETER_START && index < WALLS_END) return "wall"; // perimeter + all interior structural walls
  if (index >= COVER_START && index < COVER_END) return "crate";
  return "ramp"; // stairs + heaven platform
}

// Flat fallback tint per zone (used only if a caller renders a GrayboxSurface
// directly without a texture-based MaterialSet — kept for parity with the
// pre-M5 flat-color renderer path). Roughly mirrors materials.ts's PALETTE
// without requiring this file to import anything DOM-touching.
const ZONE_FLAT_COLOR: Record<Zone, number> = {
  attackerSide: 0x8a6a4a,
  defenderSide: 0x4a6a72,
  mid: 0x6a6a5f,
  siteA: 0x8a6a4a,
  siteB: 0x4a6a72,
};

export const GRAYBOX_BOXES: GrayboxSurface[] = LEVEL_BOXES.map((b) => {
  const zone = classifyZone(b);
  return { ...b, zone, color: ZONE_FLAT_COLOR[zone] };
});

export const SPAWN_POSITION = SIM_SPAWN_POSITION;

// ---------------------------------------------------------------------------
// M5 level dressing: non-colliding detail meshes, props, fill lights, skybox.
// ---------------------------------------------------------------------------

/**
 * Static mesh/light budget (spec acceptance criterion 4). Counted once per
 * InstancedMesh regardless of instance count, per spec ("instance props
 * where repeated"). Perf note (spec: "document a quick perf note"): the
 * level dressing below produces on the order of ~20 additional draw calls
 * (one per non-instanced mesh + one per InstancedMesh), on top of the 20
 * base LEVEL_BOXES collision meshes and per-player view/remote models — at
 * <100 total draw calls for the whole scene, a 144fps budget (~6.9ms/frame)
 * has ample headroom even on integrated GPUs; each draw call here is a
 * handful of triangles (boxes/planes/spheres), not batched geometry, so the
 * bottleneck (if any) would be state-change overhead, not vertex throughput.
 */
export const LEVEL_DRESSING_MESH_BUDGET = 150;
export const LEVEL_DRESSING_LIGHT_BUDGET = 8;
/** Fill lights added by buildLevelDressing() alone — createScene()'s hemisphere + sun account for the other 2 of the 8-light total budget. */
export const FILL_LIGHT_BUDGET = 6;

export interface LevelDressingHandle {
  group: THREE.Group;
  meshCount: number;
  lightCount: number;
  dispose(scene: THREE.Scene): void;
}

function box(w: number, h: number, d: number, material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

const ZONES_FOR_FILL_LIGHTS: readonly Zone[] = ["attackerSide", "defenderSide", "mid", "siteA", "siteB"];

/** Representative world position for a zone's fill light — site centers from SITE_ZONES, spawn centers from ATTACKER/DEFENDER_SPAWNS, origin for mid. */
function zoneLightPosition(zone: Zone): { x: number; y: number; z: number } {
  if (zone === "siteA" || zone === "siteB") {
    const site = SITE_ZONES.find((s) => (zone === "siteA" ? s.name === "A" : s.name === "B"))!;
    return { x: (site.box.minX + site.box.maxX) / 2, y: 3, z: (site.box.minZ + site.box.maxZ) / 2 };
  }
  if (zone === "attackerSide") {
    const avg = ATTACKER_SPAWNS.reduce((acc, s) => ({ x: acc.x + s.x, z: acc.z + s.z }), { x: 0, z: 0 });
    return { x: avg.x / ATTACKER_SPAWNS.length, y: 3, z: avg.z / ATTACKER_SPAWNS.length };
  }
  if (zone === "defenderSide") {
    const avg = DEFENDER_SPAWNS.reduce((acc, s) => ({ x: acc.x + s.x, z: acc.z + s.z }), { x: 0, z: 0 });
    return { x: avg.x / DEFENDER_SPAWNS.length, y: 3, z: avg.z / DEFENDER_SPAWNS.length };
  }
  return { x: 0, y: 3, z: 0 };
}

function zoneLightColor(zone: Zone): number {
  if (zone === "attackerSide" || zone === "siteA") return 0xffd8a8;
  if (zone === "defenderSide" || zone === "siteB") return 0xa8e0ff;
  return 0xffffff;
}

/** One placed copy of an instanced glb (world transform relative to the scene). */
interface Placement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/**
 * Async-loads `model` and stamps it at every `placement` as InstancedMeshes —
 * one per glb primitive (each has its own material), so an N-primitive model
 * across M placements costs N draw calls total, not N×M. The model's own
 * per-primitive local transform is folded into each instance matrix. Nothing
 * appears until the .glb resolves (the underlying textured boxes are the
 * placeholder/fallback); a failed load simply leaves them bare.
 */
function instanceGlb(group: THREE.Group, model: Parameters<typeof loadModel>[0], placements: readonly Placement[]): void {
  if (placements.length === 0) return;
  void loadModel(model).then((master) => {
    if (!master) return;
    master.updateMatrixWorld(true);
    const placementMats = placements.map((p) => new THREE.Matrix4().compose(p.position, p.quaternion, p.scale));
    master.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(obj.geometry, obj.material, placements.length);
      const primLocal = obj.matrixWorld; // relative to the (identity-rooted) master
      const m = new THREE.Matrix4();
      placementMats.forEach((pm, i) => inst.setMatrixAt(i, m.multiplyMatrices(pm, primLocal)));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      group.add(inst);
    });
  });
}

// Authored prop primitive counts (assets/models/*.glb) — how many draw calls
// each instanced prop adds, for the mesh-budget tally in buildLevelDressing.
const CRATE_PRIMS = 4;
const WALL_PRIMS = 5;
// prop_wall.glb rest dims (m): 3 wide (local X) × 2.5 tall (Y) × 0.26 thick (Z).
const WALL_PANEL_W = 3;
const WALL_PANEL_H = 2.5;
const WALL_PANEL_HALF_THICK = 0.13;

function buildPropMesh(prop: PropSpec, materials: MaterialSet): THREE.Object3D {
  const group = new THREE.Group();
  if (prop.kind === "barrel") {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(prop.radius, prop.radius, prop.height, 14), materials.metalPanel);
    group.add(barrel);
    // Swap in the authored barrel (assets/models/prop_barrel.glb, ~0.63 m ⌀ ×
    // 0.9 m tall, origin at floor) once loaded, scaled to this prop's spec
    // dims. The cylinder above stays as placeholder/fallback until then.
    void loadModel("prop_barrel").then((master) => {
      if (!master) return;
      const { group: glb } = cloneModel(master);
      glb.scale.set(prop.radius / 0.315, prop.height / 0.9, prop.radius / 0.315);
      glb.position.y = -prop.height / 2; // group origin is the prop's center; .glb origin is its base
      group.clear();
      group.add(glb);
    });
  } else {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(prop.radius * 0.85, prop.radius * 0.18, 8, 16), materials.woodCrate);
    rim.rotation.x = Math.PI / 2;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(prop.radius * 0.3, prop.radius * 0.3, prop.height, 10), materials.metalPanel);
    group.add(rim, hub);
  }
  group.position.set(prop.x, prop.y, prop.z);
  return group;
}

/**
 * Builds every M5 level-dressing element (trim, pillars, door-frame accents,
 * site decals, spawn floor bands, props, skybox, contact-shading strips,
 * per-zone fill lights) and adds them to `scene`. Non-colliding — none of
 * this is added to any collision list; positions are chosen to hug existing
 * LEVEL_BOXES geometry (spec: "never contradicting" the collision boxes).
 * Takes an already-built `materials` (see materials.ts's createMaterialSet())
 * so this function itself never touches `document`.
 */
export function buildLevelDressing(scene: THREE.Scene, boxes: readonly Box[], materials: MaterialSet, props: readonly PropSpec[] = PROPS): LevelDressingHandle {
  const group = new THREE.Group();
  let meshCount = 0;
  let lightCount = 0;

  function add(obj: THREE.Object3D): void {
    group.add(obj);
  }

  // ---- Trim strips along every structural wall top (perimeter + interior segments, one InstancedMesh). ----
  const perimeterWalls = boxes.slice(PERIMETER_START, PERIMETER_END);
  const structuralWalls = boxes.slice(PERIMETER_START, WALLS_END);
  const trimInstanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 1), materials.metalPanel, structuralWalls.length);
  const m = new THREE.Matrix4();
  structuralWalls.forEach((wallBox, i) => {
    const sx = wallBox.maxX - wallBox.minX;
    const sz = wallBox.maxZ - wallBox.minZ;
    m.compose(
      new THREE.Vector3((wallBox.minX + wallBox.maxX) / 2, wallBox.maxY + 0.04, (wallBox.minZ + wallBox.maxZ) / 2),
      new THREE.Quaternion(),
      new THREE.Vector3(sx, 1, sz),
    );
    trimInstanced.setMatrixAt(i, m);
  });
  add(trimInstanced);
  meshCount++;

  // ---- Corner pillars at the 4 map corners (perimeter wall intersections). ----
  const floorBox = boxes[0]!;
  const corners = [
    { x: floorBox.minX, z: floorBox.minZ },
    { x: floorBox.minX, z: floorBox.maxZ },
    { x: floorBox.maxX, z: floorBox.minZ },
    { x: floorBox.maxX, z: floorBox.maxZ },
  ];
  const pillarHeight = perimeterWalls[0]!.maxY - perimeterWalls[0]!.minY + 0.2;
  const pillarInstanced = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, pillarHeight, 0.6), materials.metalPanel, corners.length);
  corners.forEach((c, i) => {
    m.compose(new THREE.Vector3(c.x, pillarHeight / 2, c.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    pillarInstanced.setMatrixAt(i, m);
  });
  add(pillarInstanced);
  meshCount++;

  // ---- Door-frame accents at the site-line chokepoint gap edges (A main / mid doors / B main). ----
  // Derived from the site-line wall segments themselves: each gap edge is a
  // segment end that isn't the map perimeter, so the posts track the layout.
  const siteLineSegments = structuralWalls.filter((w) => w.maxZ - w.minZ <= 1 && Math.abs((w.minZ + w.maxZ) / 2 - SITE_LINE_Z) < 1);
  const gapEdgeXs: number[] = [];
  for (const seg of siteLineSegments) {
    if (Math.abs(seg.minX) < LEVEL_HALF_EXTENT - 0.6) gapEdgeXs.push(seg.minX);
    if (Math.abs(seg.maxX) < LEVEL_HALF_EXTENT - 0.6) gapEdgeXs.push(seg.maxX);
  }
  const frameHeight = (siteLineSegments[0]?.maxY ?? 3) + 0.3;
  const doorFrames = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, frameHeight, 0.2), materials.hazardStripe, Math.max(1, gapEdgeXs.length));
  gapEdgeXs.forEach((x, i) => {
    m.compose(new THREE.Vector3(x, frameHeight / 2, SITE_LINE_Z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    doorFrames.setMatrixAt(i, m);
  });
  add(doorFrames);
  meshCount++;

  // ---- Site floor decals (letter + zone outline baked into one texture each). ----
  for (const site of SITE_ZONES) {
    const material = site.name === "A" ? materials.siteMarkerA : materials.siteMarkerB;
    const size = Math.min(site.box.maxX - site.box.minX, site.box.maxZ - site.box.minZ) * 0.8;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set((site.box.minX + site.box.maxX) / 2, floorBox.maxY + 0.01, (site.box.minZ + site.box.maxZ) / 2);
    add(decal);
    meshCount++;
  }

  // ---- Spawn-area team-color floor bands. ----
  function spawnBandCenter(spawns: readonly { x: number; z: number }[]): { x: number; z: number; spanX: number; spanZ: number } {
    const xs = spawns.map((s) => s.x);
    const zs = spawns.map((s) => s.z);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      z: (Math.min(...zs) + Math.max(...zs)) / 2,
      spanX: Math.max(4, Math.max(...xs) - Math.min(...xs) + 3),
      spanZ: 4,
    };
  }
  const attackerBand = spawnBandCenter(ATTACKER_SPAWNS);
  const defenderBand = spawnBandCenter(DEFENDER_SPAWNS);
  const attackerBandMesh = new THREE.Mesh(new THREE.PlaneGeometry(attackerBand.spanX, attackerBand.spanZ), materials.floorByZone.attackerSide);
  attackerBandMesh.rotation.x = -Math.PI / 2;
  attackerBandMesh.position.set(attackerBand.x, floorBox.maxY + 0.005, attackerBand.z);
  add(attackerBandMesh);
  meshCount++;
  const defenderBandMesh = new THREE.Mesh(new THREE.PlaneGeometry(defenderBand.spanX, defenderBand.spanZ), materials.floorByZone.defenderSide);
  defenderBandMesh.rotation.x = -Math.PI / 2;
  defenderBandMesh.position.set(defenderBand.x, floorBox.maxY + 0.005, defenderBand.z);
  add(defenderBandMesh);
  meshCount++;

  // ---- Props (barrels/cable spools), each anchored per propPlacement.ts's validated placement. ----
  for (const prop of props) {
    const propObj = buildPropMesh(prop, materials);
    add(propObj);
    meshCount += prop.kind === "barrel" ? 1 : 2;
  }

  // ---- Cover crates: skin every cover box (COVER_START..COVER_END) with the
  // authored 1 m unit-cube crate (prop_crate.glb), scaled to the box's dims.
  // A hair oversized (1.02×) so it fully cloaks the underlying textured box
  // without z-fighting on the shared faces. Instanced → CRATE_PRIMS draw calls. ----
  const cratePlacements: Placement[] = [];
  for (let i = COVER_START; i < COVER_END; i++) {
    const cb = boxes[i];
    if (!cb) continue;
    cratePlacements.push({
      position: new THREE.Vector3((cb.minX + cb.maxX) / 2, (cb.minY + cb.maxY) / 2, (cb.minZ + cb.maxZ) / 2),
      quaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3((cb.maxX - cb.minX) * 1.02, (cb.maxY - cb.minY) * 1.02, (cb.maxZ - cb.minZ) * 1.02),
    });
  }
  instanceGlb(group, "prop_crate", cratePlacements);
  meshCount += CRATE_PRIMS;

  // ---- Wall paneling: tile prop_wall.glb across each structural wall's long
  // face (both sides), scaling only height + per-tile width so the panel detail
  // never stretches. Instanced → WALL_PRIMS draw calls for the whole map. ----
  const wallPlacements: Placement[] = [];
  const yUp = new THREE.Vector3(0, 1, 0);
  for (let i = PERIMETER_START; i < WALLS_END; i++) {
    const wb = boxes[i];
    if (!wb) continue;
    const sizeX = wb.maxX - wb.minX;
    const sizeZ = wb.maxZ - wb.minZ;
    const height = wb.maxY - wb.minY;
    const cx = (wb.minX + wb.maxX) / 2;
    const cy = (wb.minY + wb.maxY) / 2;
    const cz = (wb.minZ + wb.maxZ) / 2;
    const alongX = sizeX >= sizeZ;
    const length = alongX ? sizeX : sizeZ;
    const halfThick = (alongX ? sizeZ : sizeX) / 2;
    const faceOffset = Math.max(0, halfThick - WALL_PANEL_HALF_THICK); // panel outer face ~flush with the wall face
    const nTiles = Math.max(1, Math.round(length / WALL_PANEL_W));
    const tileLen = length / nTiles;
    const scale = new THREE.Vector3(tileLen / WALL_PANEL_W, height / WALL_PANEL_H, 1);
    for (let t = 0; t < nTiles; t++) {
      const along = -length / 2 + (t + 0.5) * tileLen;
      for (const side of [1, -1] as const) {
        // side +1 faces +axis, -1 faces the opposite; a Y-rotation aims the panel's +Z normal outward.
        const quaternion = new THREE.Quaternion().setFromAxisAngle(yUp, alongX ? (side === 1 ? 0 : Math.PI) : side * (Math.PI / 2));
        const position = alongX
          ? new THREE.Vector3(cx + along, cy, cz + side * faceOffset)
          : new THREE.Vector3(cx + side * faceOffset, cy, cz + along);
        wallPlacements.push({ position, quaternion, scale: scale.clone() });
      }
    }
  }
  instanceGlb(group, "prop_wall", wallPlacements);
  meshCount += WALL_PRIMS;

  // ---- Contact shading: dark gradient strips at wall bases (cheap fake AO). ----
  const contactMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false });
  const contactInstanced = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.3), contactMaterial, perimeterWalls.length);
  perimeterWalls.forEach((wallBox, i) => {
    const sx = wallBox.maxX - wallBox.minX;
    const sz = wallBox.maxZ - wallBox.minZ;
    const alongX = sx >= sz;
    const length = alongX ? sx : sz;
    const rot = new THREE.Quaternion();
    rot.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, alongX ? 0 : Math.PI / 2));
    m.compose(new THREE.Vector3((wallBox.minX + wallBox.maxX) / 2, floorBox.maxY + 0.008, (wallBox.minZ + wallBox.maxZ) / 2), rot, new THREE.Vector3(length, 1, 1));
    contactInstanced.setMatrixAt(i, m);
  });
  add(contactInstanced);
  meshCount++;

  // ---- Skybox: inverted gradient sphere + a few billboard clouds. ----
  const skyGeometry = new THREE.SphereGeometry(150, 24, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: { topColor: { value: new THREE.Color(0x1a1d3a) }, bottomColor: { value: new THREE.Color(0xff9a5a) } },
    vertexShader: `varying vec3 vWorldPos; void main() { vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vWorldPos; void main() { float h = normalize(vWorldPos).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0); }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  add(sky);
  meshCount++;

  const cloudMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2e0, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  const cloudCount = 5;
  const clouds = new THREE.InstancedMesh(new THREE.PlaneGeometry(18, 6), cloudMaterial, cloudCount);
  for (let i = 0; i < cloudCount; i++) {
    const angle = (i / cloudCount) * Math.PI * 2;
    const radius = 90;
    m.compose(
      new THREE.Vector3(Math.cos(angle) * radius, 40 + i * 4, Math.sin(angle) * radius),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    clouds.setMatrixAt(i, m);
  }
  add(clouds);
  meshCount++;

  // ---- Per-zone fill lights (static, max FILL_LIGHT_BUDGET). ----
  for (const zone of ZONES_FOR_FILL_LIGHTS) {
    const pos = zoneLightPosition(zone);
    const light = new THREE.PointLight(zoneLightColor(zone), 0.6, 14);
    light.position.set(pos.x, pos.y, pos.z);
    add(light);
    lightCount++;
  }

  scene.add(group);

  return {
    group,
    meshCount,
    lightCount,
    dispose(targetScene: THREE.Scene) {
      targetScene.remove(group);
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
          obj.geometry.dispose();
        }
      });
    },
  };
}
