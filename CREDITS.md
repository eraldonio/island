# Credits and provenance

Everything the app ships is either this project's own work or the public-domain
geometry listed below. There are no runtime dependencies: no library is loaded,
no asset is fetched, and nothing here needs to be installed to run the app.

## Model packs

The pack models in `src/models.packs.js` are baked from the packs below by
`tools/import-pack.mjs`. Only CC0 packs belong in that file — public domain, no
attribution, no restrictions — and every pack used has to be listed here.

| Pack | Licence | Models taken | Source |
| --- | --- | --- | --- |
| Kenney Nature Kit 2.1 | CC0 1.0 | `pack-tree`, `pack-pine`, `pack-fir`, `pack-bush`, `pack-mushroom`, `pack-cactus`, `pack-stump`, `pack-logs`, `pack-flower`, `pack-grass` | https://kenney.nl/assets/nature-kit |
| Quaternius Farm Animals Pack | CC0 1.0 | `cow`, `horse`, `llama`, `sheep`, `pig`, `pug`, `zebra` | https://opengameart.org/content/lowpoly-animated-farm-animal-pack |
| Quaternius Animal Pack Vol.2 | CC0 1.0 | `cat`, `dog`, `wolf`, `eagle`, `piranha` | https://opengameart.org/content/animated-animales-low-poly |
| Quaternius Animals Pack | CC0 1.0 | `fox`, `bird`, `chick`, `fish`, `whale` | https://opengameart.org/content/5-low-poly-animals |
| Quaternius Pirate Pack | CC0 1.0 | `chest`, `cannon`, `skull`, `telescope` | https://opengameart.org/content/low-poly-pirate-pack |
| Quaternius Car Pack | CC0 1.0 | `car`, `police-car`, `taxi`, `racer`, `van`, `compact` | https://opengameart.org/content/lowpoly-cars |

The packs' own licence reads:

> License: (Creative Commons Zero, CC0)
> http://creativecommons.org/publicdomain/zero/1.0/
> This content is free to use in personal, educational and commercial projects.
> Support us by crediting Kenney or www.kenney.nl (this is not mandatory)

> Farm Animals Pack was created by Quaternius
> https://www.patreon.com/quaternius

Every model's card in the gallery names the pack it came from, and each baked
entry carries its own `source` string, so the record survives into the app.

What the converter does to that geometry, so the record is complete:

* reads Wavefront OBJ + MTL, turning each face's material `Kd` into a flat colour
  (the renderer has no textures, so a textured pack would come out single-coloured
  and is deliberately out of scope);
* where a pack leaves every `Kd` at Blender's default grey, recovers the colour
  from the material's *name* (`NAMED` in the tool) and, for a mesh whose
  materials are all called `Material.001`, from the pick's single `tint` — listed
  per model in the tool's `PACKS` table, which is where the fox's rust, the
  taxi's yellow and the police car's white come from;
* turns a closed mesh that a pack wound inside out the right way out — from the
  signed volume of its triangles, which is what the five inside-out cars in the
  Car Pack needed — and names every model it flipped in the bake table;
* rotates y-up to z-up, scales each model to a height in blocks, welds vertices
  the OBJ split for its UVs, drops zero-area faces — an animated model is baked in
  its rest pose, which is all a prop standing in the world needs;
* writes them as block-unit triangles with a colour each — the same shape the
  hand-authored models take, so they get footprints, quarter turns, hover ghosts
  and gallery cards on identical terms.

The models authored by hand in `src/models.js` are this project's own work, as are
the palette, the sticky-note papers, the projection and the renderer. The
preconfigured islands in `src/islands.js` are compositions of the two: their relief
is built from the palette, and their elements name models from either library.
