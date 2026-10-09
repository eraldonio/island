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
| Apply the current tool | click or drag on the world |
| Build / dig / paint / note / pan | `B` `D` `P` `N` `H` |
| Pick a material | `1` … `8` |
| Brush size (1×1, 3×3, 5×5) | `[` `]` |
| Place a note | the note tool, or `Shift`+click with any tool |
| Edit a note | click its text (rich text, in place) |
| Big editor | double-click a note, or its `⤢` button |
| Resize a note | drag a white corner handle — it snaps to whole blocks |
| Move a note | drag its `⠿` grip onto another block |
| Cycle paper colour / delete | `●` / `×` on the note |
| Pan | `Space`+drag, middle-drag, right-drag, wheel, or the pan tool |
| Zoom | `Ctrl`+wheel, `+` / `−`, or pinch on touch |
| Centre the view | `0` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Help | `?` |

The camera angle is fixed by design: the world only pans and zooms, which is
what makes the whole renderer cheap.

## How it works

**Fixed-angle isometric projection.** Every world point maps to the screen with
one linear equation (`src/iso.js`):

```
screenX = (x - y) * 16
screenY = (x + y) * 8 - z * 16
```

Because the camera never rotates, that map is constant, and the view ray for any
pixel is always the world vector `(-1,-1,-1)`. Two consequences fall out:

* **Picking is exact.** `raycast()` walks the voxel grid with an
  Amanatides–Woo DDA from a plane above the world and returns the first solid
  cell plus the face it entered — no raycast library, no mesh, no scene graph.
* **Depth is an integer.** Painter's-algorithm order is just `x + y + z`, so the
  visible set is sorted with one packed integer key per voxel instead of a
  z-buffer.

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
  into the ground plane with the same matrix as the projection
  (`matrix(16,8,-16,8)` scaled), so it looks like writing on the paper while
  keeping the native caret, selection, `Ctrl+B/I/U` and spellcheck.

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

**Undo/redo** is a command stack of edits (`before`/`after` per voxel, or a note
patch). A drag stroke is grouped into one command via `beginStroke`/`endStroke`,
so one `Ctrl+Z` undoes a whole sweep of blocks.

## Files

```
index.html      markup: canvas, toolbar, status, editor + help modals
styles.css      dark UI theme, sticky-note and modal styling
src/iso.js      projection, ground-plane raycast, constants
src/world.js    chunked voxel store, notes, undo/redo, palette, starter island
src/render.js   canvas renderer: culling, painter sort, note tiles, hover ghost
src/tools.js    what a click does (build/dig/paint footprints per face)
src/notes.js    note tiles: warped DOM ink, resize handles, proximity hover
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
