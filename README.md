# Island — a voxel world you can write on

An infinite isometric voxel plane. You shape terrain with blocks and pin sticky
notes to any block, editing them in place or in a pop-up rich-text editor.

No build step, no dependencies, no bundler.

## Run it

```sh
python3 -m http.server 8080      # or any static file server
# open http://localhost:8080
```

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
| Move a note to another block | drag its top bar |
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

**Notes are DOM, not canvas.** A transparent overlay holds one `position:absolute`
element per note, positioned with `translate3d` and counter-scaled so the text
stays readable at any zoom. Editing is real `contenteditable` — WYSIWYG, native
caret, native `Ctrl+B/I/U`, real selection, working spellcheck — and the same
markup is what gets stored. Pasted HTML is passed through a tag/attribute
whitelist (`sanitizeHtml`) before it ever reaches the model, as is anything
loaded from disk or `localStorage`.

**Undo/redo** is a command stack of edits (`before`/`after` per voxel, or a note
patch). A drag stroke is grouped into one command via `beginStroke`/`endStroke`,
so one `Ctrl+Z` undoes a whole sweep of blocks.

## Files

```
index.html      markup: canvas, toolbar, status, editor + help modals
styles.css      dark UI theme, sticky-note and modal styling
src/iso.js      projection, ground-plane raycast, constants
src/world.js    chunked voxel store, notes, undo/redo, palette, starter island
src/render.js   canvas renderer: culling, painter sort, hover ghost
src/tools.js    what a click does (build/dig/paint footprints per face)
src/notes.js    sticky-note DOM layer, drag, HTML sanitizer
src/store.js    localStorage autosave, JSON export/import
src/main.js     wiring: input, camera, shortcuts, editor modal, status
```

## Data, saving, scripting

Everything is saved to `localStorage` (debounced, plus on unload) and can be
exported/imported as JSON from the bottom-right buttons.

For scripting or repair from the browser console, the app exposes itself:

```js
island.world.get(0, 0, 0)                                  // material id or undefined
island.world.apply([{ x: 0, y: 0, z: 5, mat: 2 }])         // one undoable edit
island.world.count, island.world.notes, island.cam         // live state
island.save()                                              // force a save
```

## Limits

* The world is bounded to `z = 0…128`; x and y are unbounded.
* Notes always draw above terrain (they are DOM), which is deliberate for a note
  tool but means a note is never hidden behind a hill.
* Every frame sorts the *visible* voxels: a scene showing tens of thousands of
  blocks will drop frames while panning. Typical islands and note canvases are
  three orders of magnitude below that.
* Touch pan/pinch is implemented but has only been exercised with a mouse.
