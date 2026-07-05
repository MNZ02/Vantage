// M5 visual identity: canvas-generated procedural textures + the map's
// per-zone color language. Everything here is drawn once at boot (256-512px
// canvases) with the 2D canvas API — no binary assets, no external fetches.
//
// REAL-ASSET SWAP POINT: a future pass with commissioned map materials
// (baked albedo/normal/roughness texture sets) would replace this file's
// canvas-drawing functions wholesale — createMaterialSet()'s return shape
// (one THREE.Material per named surface/zone) is the seam a real asset
// pipeline would plug into, so graybox.ts's level-dressing code wouldn't
// need to change at all.
//
// NOTE: this module touches `document.createElement("canvas")` and must
// only ever be called from browser code (main.ts) — never imported by a
// pure-logic unit test. graybox.ts's mesh-building functions take an
// already-built MaterialSet as a parameter specifically so they stay
// DOM-free and testable (see level-dressing-budget.test.ts, which passes in
// plain MeshBasicMaterials instead).
import * as THREE from "three";
import type { Zone } from "./zones.js";

export interface ZonePalette {
  wall: number;
  accent: number;
  floorTint: number;
}

/** Spec item 1: attacker side warm, defender side cool, mid neutral, sites accent (gold A / crimson B). */
export const PALETTE: Record<Zone, ZonePalette> = {
  attackerSide: { wall: 0x8a6a4a, accent: 0xc98a4a, floorTint: 0x6b5340 },
  defenderSide: { wall: 0x4a6a72, accent: 0x3f8a94, floorTint: 0x3d545a },
  mid: { wall: 0x6a6a5f, accent: 0x8a8a6a, floorTint: 0x54544a },
  siteA: { wall: 0x8a6a4a, accent: 0xd4af37, floorTint: 0x6b5638 },
  siteB: { wall: 0x4a6a72, accent: 0xa23b3b, floorTint: 0x5a3d3d },
};

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = canvas.getContext("2d");
  if (!c) throw new Error("2D canvas context unavailable");
  return c;
}

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/** Small deterministic PRNG (mulberry32) — cosmetic texture noise only, no purity constraint here (client-side, not sim). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Concrete: base fill + subtle noise speckle + a few hairline cracks. */
function drawConcrete(ctx: CanvasRenderingContext2D, size: number, baseColor: number): void {
  ctx.fillStyle = hexToCss(baseColor);
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(0x51ea5 ^ baseColor);
  const speckles = size * size * 0.06;
  for (let i = 0; i < speckles; i++) {
    const shade = rand() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${0.04 + rand() * 0.05})`;
    ctx.fillRect(rand() * size, rand() * size, 1, 1);
  }
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = 1;
  const crackCount = 4;
  for (let i = 0; i < crackCount; i++) {
    ctx.beginPath();
    let x = rand() * size;
    let y = rand() * size;
    ctx.moveTo(x, y);
    const segments = 4 + Math.floor(rand() * 3);
    for (let s = 0; s < segments; s++) {
      x += (rand() - 0.5) * size * 0.25;
      y += (rand() - 0.5) * size * 0.25;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Metal panel: brushed horizontal lines + a rivet grid. */
function drawMetalPanel(ctx: CanvasRenderingContext2D, size: number, baseColor: number): void {
  ctx.fillStyle = hexToCss(baseColor);
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(0x8a17e5 ^ baseColor);
  for (let y = 0; y < size; y += 2) {
    const shade = rand() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${0.03 + rand() * 0.04})`;
    ctx.fillRect(0, y, size, 1);
  }
  const rivetSpacing = size / 8;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  for (let gx = rivetSpacing / 2; gx < size; gx += rivetSpacing) {
    for (let gy = rivetSpacing / 2; gy < size; gy += rivetSpacing) {
      ctx.beginPath();
      ctx.arc(gx, gy, size * 0.012, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Wood crate: horizontal planks with a grain-tone gradient + darker seams. */
function drawWoodCrate(ctx: CanvasRenderingContext2D, size: number, baseColor: number): void {
  ctx.fillStyle = hexToCss(baseColor);
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(0xc2a7e ^ baseColor);
  const plankCount = 5;
  const plankHeight = size / plankCount;
  for (let p = 0; p < plankCount; p++) {
    const shade = (rand() - 0.5) * 24;
    ctx.fillStyle = `rgba(${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${shade > 0 ? 255 : 0},${Math.abs(shade) / 255})`;
    ctx.fillRect(0, p * plankHeight, size, plankHeight);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.moveTo(0, p * plankHeight);
    ctx.lineTo(size, p * plankHeight);
    ctx.stroke();
  }
  for (let i = 0; i < size * 0.6; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.02 + rand() * 0.03})`;
    const x = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 6, size);
    ctx.stroke();
  }
}

/** Hazard stripes: 45-degree black/yellow bars. */
function drawHazardStripes(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#e8b923";
  const stripeWidth = size / 8;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  ctx.translate(-size, -size);
  for (let x = 0; x < size * 3; x += stripeWidth * 2) {
    ctx.fillRect(x, 0, stripeWidth, size * 3);
  }
  ctx.restore();
}

/** Floor grid: base tint + a faint technical grid overlay. */
function drawFloorGrid(ctx: CanvasRenderingContext2D, size: number, baseColor: number): void {
  ctx.fillStyle = hexToCss(baseColor);
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const cells = 8;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * size;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
}

/** Site marker decal: a big "A"/"B" letter on a subtle circular zone-outline. */
function drawSiteMarker(ctx: CanvasRenderingContext2D, size: number, letter: "A" | "B", accent: number): void {
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = hexToCss(accent);
  ctx.lineWidth = size * 0.02;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = hexToCss(accent);
  ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, size / 2, size * 0.54);
  ctx.globalAlpha = 1;
}

function textureFromDraw(size: number, draw: (ctx: CanvasRenderingContext2D) => void, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const canvas = makeCanvas(size);
  draw(ctx2d(canvas));
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface MaterialSet {
  /** Zone-tinted wall material (concrete texture, tinted per PALETTE[zone].wall). */
  wallByZone: Record<Zone, THREE.Material>;
  /** Zone-tinted floor material (grid texture, tinted per PALETTE[zone].floorTint). */
  floorByZone: Record<Zone, THREE.Material>;
  metalPanel: THREE.Material;
  woodCrate: THREE.Material;
  hazardStripe: THREE.Material;
  siteMarkerA: THREE.Material;
  siteMarkerB: THREE.Material;
}

const TEXTURE_SIZE = 256;
const ZONES: readonly Zone[] = ["attackerSide", "defenderSide", "mid", "siteA", "siteB"];

/** Builds every procedural material once. Call exactly once at boot (main.ts) — never in a unit test (uses `document`). */
export function createMaterialSet(): MaterialSet {
  const wallByZone = {} as Record<Zone, THREE.Material>;
  const floorByZone = {} as Record<Zone, THREE.Material>;
  for (const zone of ZONES) {
    const palette = PALETTE[zone];
    const wallTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawConcrete(ctx, TEXTURE_SIZE, palette.wall), 2, 1);
    wallByZone[zone] = new THREE.MeshStandardMaterial({ map: wallTexture, roughness: 0.92, metalness: 0.04 });
    const floorTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawFloorGrid(ctx, TEXTURE_SIZE, palette.floorTint), 8, 8);
    floorByZone[zone] = new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.85, metalness: 0.02 });
  }

  const metalTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawMetalPanel(ctx, TEXTURE_SIZE, 0x6f7480), 1, 1);
  const woodTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawWoodCrate(ctx, TEXTURE_SIZE, 0xb08a4a), 1, 1);
  const hazardTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawHazardStripes(ctx, TEXTURE_SIZE), 2, 1);
  const siteATexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawSiteMarker(ctx, TEXTURE_SIZE, "A", PALETTE.siteA.accent));
  const siteBTexture = textureFromDraw(TEXTURE_SIZE, (ctx) => drawSiteMarker(ctx, TEXTURE_SIZE, "B", PALETTE.siteB.accent));
  siteATexture.wrapS = siteATexture.wrapT = THREE.ClampToEdgeWrapping;
  siteBTexture.wrapS = siteBTexture.wrapT = THREE.ClampToEdgeWrapping;

  return {
    wallByZone,
    floorByZone,
    metalPanel: new THREE.MeshStandardMaterial({ map: metalTexture, roughness: 0.5, metalness: 0.6 }),
    woodCrate: new THREE.MeshStandardMaterial({ map: woodTexture, roughness: 0.85, metalness: 0.02 }),
    hazardStripe: new THREE.MeshStandardMaterial({ map: hazardTexture, roughness: 0.7, metalness: 0.1 }),
    siteMarkerA: new THREE.MeshBasicMaterial({ map: siteATexture, transparent: true, depthWrite: false }),
    siteMarkerB: new THREE.MeshBasicMaterial({ map: siteBTexture, transparent: true, depthWrite: false }),
  };
}
