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
| Place a model | `M` (or the place tool) opens the gallery, pick a prefab, then click the world: it rests on that column's surface and takes its own footprint |
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

**Prefab models.** `src/models.js` is a small library of low-poly voxel models
(tree, pine, bush, house, duck, boat, boulder, cactus, well, campfire, mushroom,
snowman, ruins) — each just a list of `[x, y, z, mat]` cells with the origin at
its min corner, so the footprint is derived, never declared. The gallery draws
each one with the same projection and palette the world uses (a static painter
shares the renderer's face geometry), and stamping places the whole model as a
single undoable edit: footprint centred on the clicked column, resting on that
column's surface, following the face you click exactly like a single block does.

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
src/render.js   canvas renderer: culling, painter sort, note tiles, hover ghost
src/tools.js    what a click does (build/dig/paint footprints per face)
src/notes.js    note tiles: warped DOM ink, resize handles, proximity hover
src/models.js   the low-poly prefab library (voxel cells + footprint helpers)
src/gallery.js  the model panel: cards, live isometric previews, selection
src/store.js    localStorage autosave, JSON export/import, v1 migration
src/main.js     wiring: input, camera, shortcuts, editor modal, status
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

## Limits

* The world is bounded to `z = 0…128`; x and y are unbounded.
* The far end of the view slider is a map view: heights stop being visible
  (C = 0) in exchange for perfectly readable note writing. Slide back towards
  the left for the 3D look.
* A tile is rigid: it rests on the highest block under its footprint, so on very
  uneven ground it bridges dips. Terrain in front still occludes it, and a note
  that ends up mostly hidden fades to a ghost rather than disappearing.
* Text capacity is set by the footprint — roughly two characters per block.
  Long notes want a bigger tile (drag a corner) or the pop-up editor, which
  always shows everything.
* Every frame sorts the *visible* voxels and tiles: a scene showing tens of
  thousands of blocks will drop frames while panning. Typical islands and note
  canvases are three orders of magnitude below that.
* Touch pan/pinch is implemented but has only been exercised with a mouse.
