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
import { cloneModel, getLoadedModel, loadModel } from "./assets.js";
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
 *
 * `mapCoplanar`: skins that sit on the same faces as map_crossing.glb (wall
 * panels, cover crates). Hidden once the baked map is live so they don't
 * z-fight; still drawn over the procedural graybox if the map fails to load.
 */
function instanceGlb(
  group: THREE.Group,
  model: Parameters<typeof loadModel>[0],
  placements: readonly Placement[],
  opts: { mapCoplanar?: boolean } = {},
): void {
  if (placements.length === 0) return;
  void loadModel(model).then((master) => {
    if (!master) return;
    master.updateMatrixWorld(true);
    const placementMats = placements.map((p) => new THREE.Matrix4().compose(p.position, p.quaternion, p.scale));
    // Map already owns these surfaces — skip coplanar skins entirely when it's up.
    const hideForMap = !!opts.mapCoplanar && !!getLoadedModel("map_crossing");
    master.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const inst = new THREE.InstancedMesh(obj.geometry, obj.material, placements.length);
      const primLocal = obj.matrixWorld; // relative to the (identity-rooted) master
      const m = new THREE.Matrix4();
      placementMats.forEach((pm, i) => inst.setMatrixAt(i, m.multiplyMatrices(pm, primLocal)));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      if (opts.mapCoplanar) inst.userData.mapCoplanarDressing = true;
      if (hideForMap) inst.visible = false;
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
    decal.position.set((site.box.minX + site.box.maxX) / 2, floorBox.maxY + 0.02, (site.box.minZ + site.box.maxZ) / 2);
    // Site markers share materials across frames; enable polygonOffset on the
    // shared mat once so they don't shimmer against the floor.
    if (material instanceof THREE.Material) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -2;
      material.depthWrite = false;
    }
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
  // Slightly above the floor + polygonOffset so bands don't z-fight map/graybox floors.
  function floorDecalMaterial(base: THREE.Material): THREE.Material {
    const m = base.clone();
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -2;
    m.depthWrite = false;
    return m;
  }
  const attackerBandMesh = new THREE.Mesh(new THREE.PlaneGeometry(attackerBand.spanX, attackerBand.spanZ), floorDecalMaterial(materials.floorByZone.attackerSide));
  attackerBandMesh.rotation.x = -Math.PI / 2;
  attackerBandMesh.position.set(attackerBand.x, floorBox.maxY + 0.02, attackerBand.z);
  add(attackerBandMesh);
  meshCount++;
  const defenderBandMesh = new THREE.Mesh(new THREE.PlaneGeometry(defenderBand.spanX, defenderBand.spanZ), floorDecalMaterial(materials.floorByZone.defenderSide));
  defenderBandMesh.rotation.x = -Math.PI / 2;
  defenderBandMesh.position.set(defenderBand.x, floorBox.maxY + 0.02, defenderBand.z);
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
  instanceGlb(group, "prop_crate", cratePlacements, { mapCoplanar: true });
  meshCount += CRATE_PRIMS;

  // ---- Wall paneling: tile prop_wall.glb across each structural wall's long
  // face (both sides), scaling only height + per-tile width so the panel detail
  // never stretches. Instanced → WALL_PRIMS draw calls for the whole map.
  // Hidden when map_crossing is live (same faces → z-fight). When shown over
  // the graybox, sit 3 cm outside the wall face so flush coplanars don't shimmer. ----
  const wallPlacements: Placement[] = [];
  const yUp = new THREE.Vector3(0, 1, 0);
  const PANEL_OUTSET_M = 0.03;
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
    // Outer face of panel sits just outside the wall face (not flush).
    const faceOffset = Math.max(0, halfThick - WALL_PANEL_HALF_THICK) + PANEL_OUTSET_M;
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
  instanceGlb(group, "prop_wall", wallPlacements, { mapCoplanar: true });
  meshCount += WALL_PRIMS;

  // ---- Contact shading: dark gradient strips at wall bases (cheap fake AO). ----
  // polygonOffset so the strip doesn't z-fight the floor / map_crossing top.
  const contactMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
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

  // ---- Skybox: multi-band dusk dome (zenith → warm horizon → ground haze)
  // with a soft sun disc aligned to the scene's directional light, plus soft
  // layered cloud billboards. Visual-only; does not affect collision. ----
  const sunDir = new THREE.Vector3(20, 30, 10).normalize();
  const skyGeometry = new THREE.SphereGeometry(180, 48, 32);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      zenithColor: { value: new THREE.Color(0x0c1028) },
      midColor: { value: new THREE.Color(0x2a3560) },
      horizonColor: { value: new THREE.Color(0xff8a5c) },
      groundColor: { value: new THREE.Color(0x3a2838) },
      sunColor: { value: new THREE.Color(0xffe6b0) },
      sunDir: { value: sunDir.clone() },
      sunSize: { value: 0.035 },
      sunBloom: { value: 0.22 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldDir = worldPos.xyz - cameraPosition;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // Force sky to the far plane so nothing clips through it.
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 zenithColor;
      uniform vec3 midColor;
      uniform vec3 horizonColor;
      uniform vec3 groundColor;
      uniform vec3 sunColor;
      uniform vec3 sunDir;
      uniform float sunSize;
      uniform float sunBloom;
      varying vec3 vWorldDir;

      // Tiny hash for soft atmospheric grain (not sim PRNG — cosmetic only).
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vec3 dir = normalize(vWorldDir);
        float elev = dir.y; // -1..1

        // Elevation remap: ground band below horizon, sky above.
        float skyT = clamp(elev * 0.5 + 0.5, 0.0, 1.0);
        // Bias so the warm band sits near the horizon (Valorant-style dusk).
        float h = pow(skyT, 0.72);

        vec3 col;
        if (elev < 0.0) {
          // Below horizon: quick fade into ground haze (map walls occlude most of this).
          float g = clamp(-elev * 2.5, 0.0, 1.0);
          col = mix(horizonColor * 0.55, groundColor, g);
        } else {
          // Three-stop sky: horizon → mid → zenith.
          float toMid = smoothstep(0.0, 0.35, elev);
          float toZenith = smoothstep(0.25, 0.95, elev);
          col = mix(horizonColor, midColor, toMid);
          col = mix(col, zenithColor, toZenith);
          // Slight azimuth warm bias toward the sun so the lit side of the sky is richer.
          float sunAz = max(0.0, dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))));
          col = mix(col, col * vec3(1.08, 1.0, 0.95), sunAz * (1.0 - elev) * 0.35);
        }

        // Soft sun disc + bloom (matches createScene sun direction).
        float sunDot = max(0.0, dot(dir, normalize(sunDir)));
        float disc = smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.35, sunDot);
        float bloom = pow(sunDot, 24.0) * sunBloom;
        float corona = pow(sunDot, 6.0) * 0.12;
        col += sunColor * (disc * 1.4 + bloom + corona);

        // Horizon glow strip.
        float hz = exp(-abs(elev) * 8.0);
        col += horizonColor * hz * 0.18;

        // Subtle film grain so the dome doesn't read as a flat shader ball.
        float grain = (hash(dir.xz * 40.0 + dir.y * 11.0) - 0.5) * 0.025;
        col += grain;

        // Cheap dither against large-area banding on the gradient.
        col += (hash(gl_FragCoord.xy) - 0.5) * 0.012;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  add(sky);
  meshCount++;

  // Soft multi-lobe cloud billboards (shader-tinted, horizon-hugging).
  const cloudMaterial = new THREE.ShaderMaterial({
    uniforms: {
      cloudColor: { value: new THREE.Color(0xffd4b8) },
      opacity: { value: 0.42 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 cloudColor;
      uniform float opacity;
      varying vec2 vUv;

      float blob(vec2 uv, vec2 c, vec2 s) {
        vec2 d = (uv - c) / s;
        return exp(-dot(d, d));
      }

      void main() {
        // Layered soft ellipses → cumulus-ish silhouette without textures.
        float a = 0.0;
        a += blob(vUv, vec2(0.50, 0.48), vec2(0.38, 0.28));
        a += blob(vUv, vec2(0.32, 0.52), vec2(0.22, 0.20));
        a += blob(vUv, vec2(0.68, 0.50), vec2(0.24, 0.18));
        a += blob(vUv, vec2(0.45, 0.62), vec2(0.18, 0.14));
        a += blob(vUv, vec2(0.58, 0.38), vec2(0.20, 0.12));
        a = smoothstep(0.15, 0.75, a);
        // Soft edge fade so billboard rects don't show.
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x)
                   * smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
        a *= edge;
        if (a < 0.02) discard;
        // Slight undershadow so clouds read volume against the bright horizon.
        float shade = mix(0.75, 1.05, smoothstep(0.3, 0.7, vUv.y));
        gl_FragColor = vec4(cloudColor * shade, a * opacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const cloudCount = 8;
  const clouds = new THREE.InstancedMesh(new THREE.PlaneGeometry(28, 10), cloudMaterial, cloudCount);
  for (let i = 0; i < cloudCount; i++) {
    const angle = (i / cloudCount) * Math.PI * 2 + i * 0.35;
    const radius = 95 + (i % 3) * 12;
    const elev = 18 + (i % 4) * 7 + (i % 2) * 3;
    const scale = 0.75 + (i % 3) * 0.35;
    m.compose(
      new THREE.Vector3(Math.cos(angle) * radius, elev, Math.sin(angle) * radius),
      // Face roughly toward map center so billboards read as a ring.
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle + Math.PI, 0)),
      new THREE.Vector3(scale, scale * (0.55 + (i % 2) * 0.15), 1),
    );
    clouds.setMatrixAt(i, m);
  }
  clouds.instanceMatrix.needsUpdate = true;
  clouds.frustumCulled = false;
  clouds.renderOrder = -999;
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
