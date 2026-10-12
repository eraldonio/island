# Island — a voxel world you can write on

An infinite isometric voxel plane. You shape terrain with blocks and stick
post-it notes flat on the surface, sized in whole blocks, edited in place or in
a pop-up rich-text editor.

No build step, no dependencies, no bundler.

## Run it

```sh
python3 serve.py                 # dev server with caching disabled
# open http://localhost:8080
```

Any static file server works (`python3 -m http.server 8080`, `npx serve`, …);
`serve.py` just sends `no-store` so edits always reload.

Opening `index.html` over `file://` will not work: the app uses ES modules,
which browsers refuse to load from the filesystem.

## Controls

| Action | Input |
| --- | --- |
| Apply the current tool | click, or drag — one action per block the cursor moves into (holding still does nothing more) |
| Build / dig / paint / note / place / pan | `B` `D` `P` `N` `M` `H` |
| Place a model | `M` (or the place tool) opens the gallery — a panel of models that scrolls under the wheel once the list is longer than the screen — pick a prefab, then click the world: it claims its own whole-block footprint, centred on that column and resting on its surface |
| Remove a placed model | dig it (undo brings it back) |
| Move a placed model | `G` (or the move tool), then drag it: it keeps its place under the pointer, snaps to whole blocks and rides the surface it lands on — the whole drag is one undo step |
| Turn a placed model | `R` / `Shift+R` — a quarter turn about the footprint's centre, so a model that is not square across shifts by at most half a block to keep its footprint on the grid |
| Pick a material | `1` … `9` |
| Brush size (1×1, 3×3, 5×5) | `[` `]` |
| Place a note | the note tool, or `Shift`+click with any tool |
| Edit a note | click its text (rich text, in place) |
| Big editor | double-click a note, or its `⤢` button |
| Resize a note | drag a white corner handle — it snaps to whole blocks |
| Move a note | drag its `⠿` grip onto another block |
| Cycle paper colour / delete | `●` / `×` on the note |
| Pan | `Space`+drag, middle-drag, right-drag, `Shift`+wheel, or the pan tool |
| Zoom | wheel (at the cursor), `Ctrl`+wheel, `+` / `−`, or pinch on touch |
| Orbit the camera | the `spin` and `tilt` sliders: spin turns the world to any azimuth, tilt raises the camera from nearly edge-on to straight down. Straight down with spin 0 makes note writing read head-on |
| Face the notes | `V` jumps between the isometric default and that straight-down pose |
| Centre the view | `0` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Help | `?` |

The camera angle is fixed by design: the world only pans and zooms, which is
what makes the whole renderer cheap.

## How it works

**Parallel projection with a free camera orbit.** Every world point maps to the
screen with one linear equation (`src/iso.js`):

```
screenX = (x cosθ - y sinθ) * H
screenY = (x sinθ + y cosθ) * D - z * C
```

Two sliders drive it. `spin` is the azimuth θ and takes any angle; `tilt` is the
elevation, which sets the ground foreshortening (D/H = sin tilt) and the height
scale (C, full at the default elevation, zero looking straight down). The
default spin 45 / tilt 30 is the classic 2:1 isometric look; spin 0 with tilt 90
puts the world axes square on the screen, where a note's writing is neither
sheared nor squashed.

Because the projection is linear at every angle, two things stay true:

* **Picking is exact.** `raycast()` walks the voxel grid with an
  Amanatides–Woo DDA along the view ray from a plane above the world, and
  returns the first solid cell plus the face it entered — no raycast library, no
  mesh, no scene graph. Only the step sizes change with the angle.
* **Depth is one number.** Painter's-algorithm order is the dot product of a
  cell with the view ray, so the visible set is sorted with one packed key per
  voxel instead of a z-buffer.

The renderer never hard-codes the isometric basis: it works from the three
screen-space images of the world axes (`U`, `V`, `W`), which is also what makes
the cube faces, the note quads and the ink's matrix rotate together.

**Chunked sparse storage.** Blocks live in `Map`s keyed by 16×16 column chunks
(`src/world.js`), so the world is unbounded on x/y with no allocation for empty
space. A per-column height index (`topAt`) makes "recolour the surface" cheap.
Voxels are only stored where they exist; a chunk is dropped when it empties.

**Rendering** (`src/render.js`): inverse-project the viewport corners at
`z = 0` and `z = 128` to get the chunk range, gather those chunks, cull voxels
whose three visible faces are all covered or that fall outside the viewport,
sort, then draw the top and two camera-facing faces per block with flat
three-tone shading. Faces are filled *and* stroked with the same colour to seal
antialiasing seams.

**Notes are flat tiles on the surface.** A note is a `w × h` block footprint —
a rigid post-it lying on the terrain, not a card floating above it. It is drawn
in two halves that share one affine map:

* The **paper** is a quad drawn by the renderer *inside the voxel painter order*,
  so a hill in front of a note covers it exactly as it covers the blocks, with a
  thickness rim and a contact shadow so it reads as a solid slab rather than a
  decal.
* The **ink** is a DOM element holding real `contenteditable` content, warped
  into the ground plane with the projection's own matrix (its columns are the
  screen-space images of the world x and y axes), so it looks like writing on
  the paper while keeping the native caret, selection, `Ctrl+B/I/U` and
  spellcheck — and it rotates with the view, reading head-on at the far end of
  the slider.

A tile rests on the highest block under its footprint, derived from the terrain
every frame, so building under a note lifts it and digging drops it. Notes that
end up mostly behind terrain fade back to a ghost instead of hiding (or worse,
drawing over the hill). Text is typeset by a smart preview: it wraps at word
boundaries, steps the size down a couple of notches while that still helps, and
then clips at a whole line — never a half line or a word cut in half. The `w×h`
badge turns amber with a `…` when there is more text than the tile shows; the
pop-up editor always has all of it.

Resizing is affine-exact: the pointer is mapped back through the tile's own
matrix, so dragging a corner handle sets `w`/`h` in whole blocks (1…16) with no
rounding drift. Because the toolbar and the corner handles live *outside* the
paper quad, the note's hover state is computed by proximity to the quad rather
than by CSS `:hover` — otherwise the handles could never be grabbed from
outside their own corner.

Editing is real `contenteditable` throughout, and the same markup is what gets
stored. Pasted HTML is passed through a tag/attribute whitelist
(`sanitizeHtml`) before it ever reaches the model, as is anything loaded from
disk or `localStorage`.

**Prefab models.** `src/models.js` is a small library of low-poly models (tree,
pine, bush, house, duck, boat, boulder, cactus, well, campfire, mushroom,
snowman, ruins). Each is a **polygon mesh** — vertices in block units, faces of
three or four of them — grown from a handful of faceted primitives (box, ball,
dome, tube, log, roof, ring) rather than a hand-written vertex list, which keeps
the shapes readable and the file short. Sizes are proportional on purpose: the
duck is about one block, the house about four.

`src/models.pack.js` adds ten more, baked from the CC0 **Kenney Nature Kit** by
`tools/import-pack.mjs` — a one-off converter (OBJ + MTL in, block-unit triangles
out) rather than a loader, so the app still ships no dependencies and loads no
model formats at runtime. A face there is one flat colour taken from its
material, because the renderer has no textures; imported models keep those
colours rather than the world's palette, so an imported tree stands out against
the terrain. See `CREDITS.md` for provenance and licence.

The map grid is used only for *placement*: `modelSize(model, rot)` reports how
many whole blocks a model claims at that quarter turn (`ceil` of the frame's
bounding box), the mesh is centred inside that footprint and rests on the clicked
column's surface, and the hover ghost shows exactly those blocks. Nothing about
the map's voxel size leaks into a shape, and a model is never cut to the grid.

Placed models are **props**, not voxels: `{ id, model, x, y, z, rot }` — a model
id, the block column it stands on and which quarter turn it faces (saves written
before `rot` existed load as turn 0). The renderer projects each prop's faces
through the same `U`, `V`, `W` basis as everything else, culls the ones that face
away from the camera, and gives every face its own painter key, so a hill in
front of a model covers exactly the part it overlaps. Faces are flat-shaded by
their normal — the diffuse term against a fixed light, quantised to sixteen tones
and cached per palette colour — which is what makes a ball of facets read as a
low-poly sphere; a turned model is shaded afresh from the turned normals, so the
light stays where it is. A door or a window is a cell of the wall rather than a
patch laid on it, because a coplanar patch sorts *behind* the wall it sits on and
would never be seen. Placement and removal are single undoable steps — dig a
model to take it away — and so are a drag (however far it goes) and a quarter
turn. The gallery draws the same geometry with a static painter that shares the
renderer's face maths.

**Undo/redo** is a command stack of edits (`before`/`after` per voxel, or a note
patch). A drag stroke is grouped into one command via `beginStroke`/`endStroke`,
so one `Ctrl+Z` undoes a whole sweep of blocks — and a stroke acts once per
block the cursor moves into, so holding the button still never stacks a tower.

## Files

```
index.html      markup: canvas, toolbar, status, editor + help modals
styles.css      dark UI theme, sticky-note and modal styling
src/iso.js      projection, ground-plane raycast, constants
src/world.js    chunked voxel store, notes, undo/redo, palette, starter island
src/render.js   canvas renderer: culling, painter sort, flat-shaded model faces,
                note tiles, hover ghost
src/tools.js    what a click does (build/dig/paint footprints per face)
src/notes.js    note tiles: warped DOM ink, resize handles, proximity hover
src/models.js   the low-poly prefab library (polygon meshes + placement helpers)
src/models.pack.js  models baked from CC0 packs (generated, do not edit)
src/gallery.js  the model panel: cards, live isometric previews, selection
src/store.js    localStorage autosave, JSON export/import, v1 migration
src/main.js     wiring: input, camera, shortcuts, editor modal, status
tools/import-pack.mjs  one-off pack converter (run by hand, not at runtime)
```

## Data, saving, scripting

Everything is saved to `localStorage` (debounced, plus on unload) and can be
exported/imported as JSON from the bottom-right buttons.

For scripting or repair from the browser console, the app exposes itself:

```js
island.world.get(0, 0, 0)                                  // material id or undefined
island.world.apply([{ x: 0, y: 0, z: 5, mat: 2 }])         // one undoable edit
island.world.surfaceUnder(x, y, w, h)                      // height a tile would rest at
island.world.count, island.world.notes, island.cam         // live state
island.save()                                              // force a save
```

A note is `{ id, x, y, w, h, color, html }`: `x,y` is the corner cell of its
footprint, `w,h` its size in blocks, `html` the sanitised rich text. Older
saves (which stored a floating pin: a fractional centre plus an explicit `z`)
are migrated on load to the corner cell plus a default tile size.

A placed model is `{ id, model, x, y, z }`: a model id from the library plus the
block column it stands on. Its geometry is regenerated from the library on every
frame, so a save only stores which model and where.

## Limits

* The world is bounded to `z = 0…128`; x and y are unbounded.
* The far end of the view slider is a map view: heights stop being visible
  (C = 0) in exchange for perfectly readable note writing. Slide back towards
  the left for the 3D look.
* A tile is rigid: it rests on the highest block under its footprint, so on very
  uneven ground it bridges dips. Terrain in front still occludes it, and a note
  that ends up mostly hidden fades to a ghost rather than disappearing.
* A placed model claims whole blocks but draws its own true shape, so a small
  model leaves most of its claimed blocks empty. Its bounding box is what occludes
  and what a dig removes, not the mesh.
* Text capacity is set by the footprint — roughly two characters per block.
  Long notes want a bigger tile (drag a corner) or the pop-up editor, which
  always shows everything.
* Every frame sorts the *visible* voxels and tiles: a scene showing tens of
  thousands of blocks will drop frames while panning. Typical islands and note
  canvases are three orders of magnitude below that.
* Touch pan/pinch is implemented but has only been exercised with a mouse.
