# ÆON — engineering conventions

A real-time, procedurally generated universe in Three.js: cosmic web → galaxy →
star system → planetary surface, explorable on foot, in a vehicle, and in a ship.

## Non-negotiables

**Quality bar.** Every visual is judged against No Man's Sky, Starfield, Outer
Wilds, Breath of the Wild and Pacific Drive. "It renders" is not done. Look for
the specific things that separate AAA from a tech demo: soft contact shadows,
correct light falloff, atmospheric perspective, material variation at every
scale, silhouettes that read at a distance, motion that has weight and follow-
through, and a colour palette that someone *chose*.

**Performance is a feature.** 60 fps on desktop, 30+ on mobile. Everything
streams, nothing hitches. Budget your work per frame and spread it across
frames — never build a whole city or a whole LOD level in one tick.

**No placeholder art.** There are no texture or model files in this project and
there never will be. Everything is generated: noise, SDFs, procedural meshes,
shader-authored materials. If you want rust, write rust.

## Layout and ownership

```
src/
  core/       engine, renderer, post FX, input, settings, noise, RNG   [integration-owned]
  universe/   seeded generators + shared types                          [integration-owned]
  api/        Contracts.ts — the treaty between modules                 [integration-owned]
  realms/     cosmos / galaxy / system / surface composition            [integration-owned]
  cosmos/     cosmic web simulation and rendering
  galaxy/     galaxy rendering, nebulae, skybox
  planet/     quadsphere LOD terrain, atmosphere, ocean, clouds
  surface/    scatter (flora/rocks), wildlife, weather
  civ/        cities, architecture, roads, interiors, monuments
  entities/   player controller, camera rig, vehicles, starship
  ui/         HUD, touch controls, menus, photo mode
  audio/      procedural music and SFX
```

Only touch files inside your own directory unless you are the integration
owner. If you need something from another module, it goes through
`src/api/Contracts.ts`.

## Rules that will bite you if you ignore them

**Logarithmic depth buffer is ON.** Any custom `ShaderMaterial` or `RawShaderMaterial`
*must* include the three.js log-depth chunks or it will z-fight into oblivion:

```glsl
// vertex
#include <common>
#include <logdepthbuf_pars_vertex>
void main(){
  ...
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
// fragment
#include <common>
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  ...
}
```

**Rendering is HDR and linear.** Do not tone map, do not gamma correct, do not
clamp to 1.0 in your shaders. Emit linear radiance; the post chain owns
exposure, AgX tone mapping, bloom and the final transform. A star's core is
supposed to be 40.0, not 1.0.

**Floating origin.** Never put a coordinate larger than ~1e7 into a Float32
attribute. The realms rebase the world around the camera; work in local metres
and read the origin from the context.

**Noise must match CPU↔GPU.** `src/core/Noise.ts` exports `snoise3`/`fbm3`/… in
TypeScript and `GLSL_NOISE` with identical implementations. Terrain rendering
and terrain collision must use the same functions or the player sinks.

**Determinism.** Use `Rng` from `src/core/Rand.ts`, seeded and forked — never
`Math.random()`. The same seed must produce the same universe forever.

**Dispose everything.** Geometries, materials, textures and render targets are
not garbage collected. Every system implements `dispose()` and actually frees.

**Quality tiers.** Read `ctx.quality` and respect it: `scatterDensity`,
`terrainMaxDepth`, `cloudSteps`, `particleBudget`, `shadows`. Implement
`setQuality()` so the adaptive system can turn you down mid-flight.

## Style

- TypeScript, ES modules, no default exports.
- Comments explain *why*, especially the physics and the art direction. Do not
  narrate what the code plainly says.
- Shaders live in template literals next to the code that uses them, composed
  from the shared chunks in `core/Noise.ts`.
- Prefer instancing, GPU-side animation, and shader-authored detail to CPU work.
- Small, boring names. `TerrainPatch`, not `AwesomeTerrainManager`.

## Verifying

```bash
npm run typecheck     # must be clean
npm run dev           # http://localhost:5173
npm run build         # must succeed
node tools/shoot.mjs  # screenshots via headless Chromium (see tools/)
```

The debug bridge `window.__aeon` is exposed at runtime for the screenshot
harness: `goto(realm)`, `teleport(...)`, `setTier(...)`, `capture()`,
`stats()`. Keep it working — the visual review loop depends on it.
