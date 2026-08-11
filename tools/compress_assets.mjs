/**
 * Draco-compress every glb in assets/models/ into assets/models/compressed/.
 *
 * Two copies exist on purpose:
 *   - assets/models/*.glb          — canonical Blender exports. The Python
 *     tooling (tools/mapgen/check_gameplay_safe.py, tools/agentgen/
 *     import_agent.py's facing probe) parses accessor bufferViews raw, which
 *     Draco removes, so these MUST stay uncompressed.
 *   - assets/models/compressed/*.glb — what the client actually downloads
 *     (packages/client/src/assets.ts points here; GLTFLoader decodes via the
 *     DRACOLoader wired in assets.ts, decoder files in
 *     packages/client/public/draco/).
 *
 * Geometry only: Draco compresses POSITION/NORMAL/UV/COLOR_0/JOINTS/WEIGHTS
 * streams. Animations, materials, node hierarchy, skin definitions and
 * embedded textures pass through untouched, so the client contracts (18-bone
 * rig names, equip/reload/inspect clips, the ag_ and vm_ material names,
 * baked AO in COLOR_0) survive byte-for-byte at the JSON level.
 *
 * Re-run after ANY Blender re-export:  pnpm assets:compress
 */
import { readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "assets/models");
const OUT = join(SRC, "compressed");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.encoder": await draco3d.createEncoderModule(),
  "draco3d.decoder": await draco3d.createDecoderModule(),
});

mkdirSync(OUT, { recursive: true });
const files = readdirSync(SRC).filter((f) => f.endsWith(".glb"));
let inTotal = 0;
let outTotal = 0;
console.log(`compressing ${files.length} glbs -> ${OUT}`);
for (const f of files) {
  const src = join(SRC, f);
  const doc = await io.read(src);
  await doc.transform(
    draco({
      method: "edgebreaker",
      // 14-bit positions ≈ 0.1 mm at map scale; 10-bit colors keep the baked
      // AO gradient band-free (the exporter already lifts blacks to 0.28+).
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 10,
      quantizeGeneric: 12,
    }),
  );
  const dst = join(OUT, f);
  await io.write(dst, doc);
  const a = statSync(src).size;
  const b = statSync(dst).size;
  inTotal += a;
  outTotal += b;
  console.log(
    `  ${f.padEnd(34)} ${(a / 1024).toFixed(0).padStart(6)} KB -> ${(b / 1024)
      .toFixed(0)
      .padStart(6)} KB  (${((1 - b / a) * 100).toFixed(0)}% smaller)`,
  );
}
console.log(
  `total ${(inTotal / 1048576).toFixed(1)} MB -> ${(outTotal / 1048576).toFixed(1)} MB`,
);
