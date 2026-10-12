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

One feature does need `serve.py`. **Harness tiles** drive a real `omp` session,
and a page cannot spawn a process, so `serve.py` doubles as the bridge: it runs
the local `omp` CLI (`--mode rpc`) behind `/api/omp` and streams its output back
over SSE. That needs `omp` on `PATH` (`ISLAND_OMP` overrides the binary,
`ISLAND_OMP_CWD` the directory it works in). It binds loopback only, and every
mutating request must carry an `X-Island` header — a header a browser cannot set
from another origin without a preflight this server never approves. Served by
anything else, the tiles still place and draw; they just read
`harness unavailable`.

Sessions live in `.island/harness/<tile id>/` and are resumed with `--continue`,
so a conversation outlives a reload (or a restart of this server).

Opening `index.html` over `file://` will not work: the app uses ES modules,
which browsers refuse to load from the filesystem.

## Controls

| Action | Input |
| --- | --- |
| Apply the current tool | click, or drag — one action per block the cursor moves into (holding still does nothing more) |
| Build / dig / paint / note / harness / place / move / pan | `B` `D` `P` `N` `K` `M` `G` `H` |
| Place a model | `M` (or the place tool) opens the gallery — a panel of models that scrolls under the wheel once the list is longer than the screen — pick a prefab, then click the world: it claims its own whole-block footprint, centred on that column and resting on its surface |
| Remove a placed model | dig it (undo brings it back) |
| Move a placed model | `G` (or the move tool), then drag it: it keeps its place under the pointer, snaps to whole blocks and rides the surface it lands on — the whole drag is one undo step |
| Turn a placed model | `R` / `Shift+R` — a quarter turn about the footprint's centre, so a model that is not square across shifts by at most half a block to keep its footprint on the grid |
| Pick a material | `1` … `9` |
| Brush size (1×1, 3×3, 5×5) | `[` `]` |
| Place a note | the note tool, or `Shift`+click with any tool — the tool then switches to pan, so the next drag moves the world instead of dropping another note |
| Edit a note | click its text (rich text, in place) |
| Big editor | double-click a note, or its `⤢` button |
| Resize a note | drag a white corner handle — it snaps to whole blocks |
| Move a note | drag its `⠿` grip onto another block |
| Cycle paper colour / delete | `●` / `×` on the note |
| Preview text size | `−` / `+` on the note, 3…40 px in steps of 1 (per note, small at 9 by default) |
| Place a harness tile | `K` (or the harness tool), then click the world — a live `omp` chat lands on the ground. The tile shows the answer streaming as it is written, so the world view is a readout of every running harness |
| Open the harness chat | click the tile's slab, or its `⤢` button — a real chat: type, watch the reply and each tool call stream in, `■` to stop a turn |
| Reset / delete a harness tile | `⟲` in the chat starts a fresh conversation for that tile; `×` on the slab removes the tile (undo brings it back) |
| Resize / move a harness tile | the same white corner handles and `⠿` grip as a note |
| Harness tile colour / preview size | `●` cycles the slab colour, `−` / `+` set the preview text size — the same per-tile knobs a note has, undoable like any other patch |
| Harness tile status | the bar across the top of a tile reads the session's own state: `idle` (up, no turns yet), `working` (a turn is running), `done` (it just finished), `waiting for input` (settled — the next move is yours, or it is blocked on a dialog), `error`, `offline` |
| Pan | `Space`+drag, right-drag, `Shift`+wheel, or the pan tool |
| Zoom | wheel (at the cursor), `Ctrl`+wheel, `+` / `−`, or pinch on touch |
| Orbit the camera | middle-drag, or the `spin` and `tilt` sliders: spin turns the world to any azimuth, tilt raises the camera from nearly edge-on to straight down. Straight down with spin 0 makes note writing read head-on |
| Face the notes | `V` jumps between the isometric default and that straight-down pose |
| Centre the view | `0` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Help | `?` |

Pans and zooms never change the angle, and a middle-drag orbits it: the whole
renderer stays cheap because the angle only has to be re-derived, never traced.

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

A note's preview size is its own `fs` (3…40 px, small at 9 by default, since a
tile is a post-it and the world view should read as one): the `−` and `+`
buttons in the note's toolbar change it, one pixel per click, and the fit ladder
starts from there — never above it, so a 3 px wall of text stays 3 px. The range
is wide on purpose: the bottom end packs a lot onto a small tile, the top end
gives one shouted line. Everything inside the ink — headings, code, quotes — is
sized in `em`, so the whole preview scales together. The change is a normal note
patch, so it undoes with `Ctrl+Z` and is saved and exported with the note.

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

**Harness tiles are notes that talk.** A harness tile is the same `w × h` ground
footprint as a note — same rigid slab, same painter order, same warped DOM in the
ground plane, same corner handles and `⠿` grip — but its ink is a live readout
instead of editable text, and it is bound to a real agent. `K` drops one; the
slab shows the tail of that tile's transcript under a **status bar**, so a glance
across the world shows every harness and what each one is doing.

The bar is derived from omp's own signals, not guessed: `working` while a turn is
running, `done` for the moment it yields, `waiting for input` once the session
settles (nothing running, nothing queued — the next move is the user's), `error`
when a turn or a command failed, `offline` when the process is gone, `idle`
before the first turn. A dialog omp is blocked on — an approval, a choice, a
free-text answer — outranks all of it and reads `waiting for input`, with the
question rendered in the chat window so the harness can be answered instead of
hanging. The bar carries the tile's own colour and preview size too, so status,
paper and type are all visible at a glance.

Each tile is one `omp --mode rpc` process, spawned by the dev server and
addressed by the tile's id (`/api/omp/<id>/…`). The page posts RPC commands
(`prompt`, `steer`, `abort`, `get_messages`, `get_state`) and follows the
process's stdout over SSE; `src/omp.js` folds that stream into a small
transcript, and both views read the same object — the slab draws its last few
lines, the chat window draws all of it. Under the hood: because a dropped frame
can be replayed after a reconnect and `message_update` carries the running
`partial` message, the transcript is rebuilt from whole messages rather than
patched from deltas, so applying a frame twice changes nothing. Opening a tile
seeds the transcript with `get_messages`, which is also what restores a resumed
session after a reload. When the process exits, the tile drops to `offline` and
the next frame brings up a fresh one on the same session id, so a crash or a
server restart heals itself; `⟲` restarts it *without* `--continue` to start a
genuinely fresh conversation.

Because a tile is a tile, everything already true of notes holds: it rests on the
highest block under it, terrain in front occludes it, its moves and resizes are
one undo step each, and it is saved and exported as
`{ id, x, y, w, h, color, fs }` — the conversation is the session's, on disk, not
the world's. `color` picks one of the dark slabs (the renderer's `CHAT_PAPER`,
cycled by `●`) and `fs` is the same preview text size a note carries, run through
the same fit ladder: the tail is typeset at the tile's own size, stepped down a
couple of notches while that still helps, and clipped at a whole line — the badge
turns amber with a `…` when there is more than the slab shows. Both are ordinary
tile patches, so they undo with `Ctrl+Z` and travel in a save.

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
index.html      markup: canvas, toolbar, status, editor + chat + help modals
styles.css      dark UI theme, sticky-note, harness-tile and modal styling
serve.py        dev server: static files, plus the omp RPC bridge over SSE
src/iso.js      projection, ground-plane raycast, constants
src/world.js    chunked voxel store, notes, harness tiles, undo/redo, palette
src/render.js   canvas renderer: culling, painter sort, flat-shaded model faces,
                note and harness tiles, hover ghost
src/tools.js    what a click does (build/dig/paint footprints per face)
src/notes.js    note tiles: warped DOM ink, resize handles, proximity hover
src/harness.js  harness tiles and the chat window: same tile maths, live stream
src/omp.js      the omp session behind one tile: RPC commands + event transcript
src/models.js   the low-poly prefab library (polygon meshes + placement helpers)
src/models.pack.js  models baked from CC0 packs (generated, do not edit)
src/gallery.js  the model panel: cards, live isometric previews, selection
src/store.js    localStorage autosave, JSON export/import, migration
src/main.js     wiring: input, camera, shortcuts, modals, status
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

A note is `{ id, x, y, w, h, color, fs, html }`: `x,y` is the corner cell of its
footprint, `w,h` its size in blocks, `fs` the preview text size in tile-local px
(missing reads as the 9 px default), `html` the sanitised rich text. Older
saves (which stored a floating pin: a fractional centre plus an explicit `z`)
are migrated on load to the corner cell plus a default tile size.

A placed model is `{ id, model, x, y, z }`: a model id from the library plus the
block column it stands on. Its geometry is regenerated from the library on every
frame, so a save only stores which model and where.

A harness tile is `{ id, x, y, w, h, color, fs }`: its footprint, a slab colour
and the preview text size — the same shape a note has, minus the rich text. The
conversation belongs to the `omp` session keyed by that `id`, kept by the dev
server under `.island/harness/<id>/`. Reach a tile from the console the same way:
`island.chatWindow.open(id)` opens its chat, `island.chats` is the tile layer,
and `island.world.chats` is the list.

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
* Text capacity is set by the footprint and the preview size — at the default
  9 px, roughly three characters per block; `−` fits more, `+` less. Long notes
  want a bigger tile (drag a corner) or the pop-up editor, which always shows
  everything.
* Every frame sorts the *visible* voxels and tiles: a scene showing tens of
  thousands of blocks will drop frames while panning. Typical islands and note
  canvases are three orders of magnitude below that.
* Touch pan/pinch is implemented but has only been exercised with a mouse.
* A harness tile needs `serve.py` *and* `omp` on `PATH`; anything else serves the
  world normally and shows the tiles as `harness unavailable`. It runs one long-
  lived `omp` process per tile, rooted in this project, so it can read, run and
  edit files exactly like the terminal harness — that is the point, and it is why
  the bridge only listens on loopback.
* A harness tile shows the *tail* of its conversation (the last few lines that
  fit); open it for the whole transcript. Its text is drawn plain, so markdown
  reads as source there rather than typeset.
