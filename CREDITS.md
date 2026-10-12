# Credits and provenance

Everything the app ships is either this project's own work or the public-domain
geometry listed below. There are no runtime dependencies: no library is loaded,
no asset is fetched, and nothing here needs to be installed to run the app.

## Model packs

The models in `src/models.pack.js` are baked from the packs below by
`tools/import-pack.mjs`. Only CC0 packs belong in that file — public domain, no
attribution, no restrictions — and every pack used has to be listed here.

| Pack | Licence | Models taken | Source |
| --- | --- | --- | --- |
| Kenney Nature Kit 2.1 | CC0 1.0 | `pack-tree`, `pack-pine`, `pack-fir`, `pack-bush`, `pack-mushroom`, `pack-cactus`, `pack-stump`, `pack-logs`, `pack-flower`, `pack-grass` | https://kenney.nl/assets/nature-kit |

The pack's own licence reads:

> License: (Creative Commons Zero, CC0)
> http://creativecommons.org/publicdomain/zero/1.0/
> This content is free to use in personal, educational and commercial projects.
> Support us by crediting Kenney or www.kenney.nl (this is not mandatory)

What the converter does to that geometry, so the record is complete:

* reads Wavefront OBJ + MTL, turning each face's material `Kd` into a flat colour
  (the renderer has no textures, so a textured pack would come out single-coloured
  and is deliberately out of scope);
* rotates y-up to z-up, scales each model to a height in blocks, welds vertices
  the OBJ split for its UVs, drops zero-area faces;
* writes them as block-unit triangles with a colour each — the same shape the
  hand-authored models take, so they get footprints, quarter turns, hover ghosts
  and gallery cards on identical terms.

The models authored by hand in `src/models.js` are this project's own work, as are
the palette, the sticky-note papers, the projection and the renderer.
