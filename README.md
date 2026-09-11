# LazyLord

**Transfer vectors, live text and images between Figma and Adobe Photoshop, Illustrator & After Effects.**

LazyLord is an open, self-hostable alternative to [Battle Axe Overlord](https://battleaxe.co/overlord). Select layers in Figma, hit **Send**, and they are rebuilt as **native** shape layers, path items, text layers and images inside your Adobe app — not flattened screenshots.

> Status: **v0.4 — Phase 2 + hierarchy.** Routes implemented end to end:
> **Figma → Photoshop / Illustrator / After Effects**, **Illustrator → After Effects** (push),
> and **After Effects → Illustrator** (pull) — now with native gradients, clipping masks,
> parametric rectangles/ellipses, correct rotation, source-sized documents, group hierarchy
> and Split/Combine layout.
>
> Everything is covered by mocked-host test suites, but **none of the v0.4 work has been run
> inside a real Adobe app or Figma yet.** Treat host-API behaviour marked *unverified* below as
> the first thing to check.

---

## How it works

Figma plugins can only reach `localhost`, and Adobe apps script through CEP/ExtendScript. LazyLord connects them with a tiny local WebSocket relay. Any connected app can send; the bridge routes a transfer to the chosen destination and the acknowledgement back to whoever started it.

```
┌────────────┐                     ┌────────────┐         ┌─────────────────────┐
│   Figma    │ ──── selection ───► │            │ ── IR ► │  Adobe CEP panel    │
│  plugin    │ ◄────── ack ─────── │   Bridge   │ ◄ ack ─ │  PS / AI / AE       │
└────────────┘                     │ (Node, ws) │         │  → ExtendScript      │
┌────────────┐ ◄─── push/pull ───► │   :7878    │         └─────────────────────┘
│  AI ⇄ AE   │                     │            │
└────────────┘                     └────────────┘
```

1. **Figma plugin** reads the selection and serialises it to a host-neutral **IR** (intermediate representation): groups, bezier contours, paints, clip paths, live-text properties and PNG fallbacks. `packages/figma-plugin`
2. **Bridge** routes each transfer to its target app and each acknowledgement back to its originator. `packages/bridge`
3. **Adobe CEP panel** (one panel, three hosts) rebuilds incoming IR natively, and — where the host has a reader — serialises its own selection to push out. `packages/adobe-cep`
4. **Core** holds the shared IR types, the transfer protocol, the SVG-path → bezier math and the pure geometry (transform baking, gradient handles, artboard detection) used by every side. `packages/core`

Everything runs on your machine — **no data leaves localhost.**

---

## Repository layout

```
lazylord/
├── packages/
│   ├── core/           # IR types, protocol, SVG-path → bezier, geometry helpers (TS)
│   ├── figma-plugin/   # Figma plugin: selection → IR → WebSocket (TS + esbuild)
│   ├── bridge/         # Local WebSocket relay (Node + ws)
│   └── adobe-cep/      # CEP panel for PS/AI/AE (HTML/JS + ExtendScript)
│       ├── js/main.js  #   panel: bridge client, push flow, options, diagnostics
│       └── jsx/        #   ae/ai/ps builders + ai-read / ae-read (readers)
├── tools/
│   ├── install-cep.ps1              # install the panel for dev (Windows)
│   ├── install-cep.sh               # install the panel for dev (macOS)
│   ├── check-extendscript.js        # ES3 syntax check (needs only cscript)
│   ├── test-ae-builder.js           # AE builder vs. a mocked AE DOM
│   ├── test-ai-builder.js           # Illustrator builder vs. a mocked AI DOM
│   ├── test-ps-builder.js           # Photoshop builder vs. mocked ActionManager/DOM
│   ├── test-illustrator-reader.js   # Illustrator reader vs. a mocked AI DOM
│   ├── test-aftereffects-reader.js  # AE reader vs. a mocked AE DOM
│   ├── test-cep-panel.js            # CEP panel vs. mocked CSInterface/WebSocket
│   ├── test-core.mjs                # core geometry + Figma plugin vs. a mocked scene (Node)
│   └── smoke-test.mjs               # path-parser checks against the built core
└── package.json        # npm workspaces
```

---

## Prerequisites

- **Node.js 18+** and npm (for building the plugin/bridge)
- **Figma desktop app** (needed to run a local dev plugin that talks to localhost)
- One or more of **Photoshop / Illustrator / After Effects, 2021 or newer** (CEP 11)

## Quick start

**Windows, one step:** double-click `install.bat`. It checks Node.js (and offers to install it with winget), runs `npm install`, builds everything, links the Adobe panel into Photoshop, Illustrator and After Effects with CEP debug mode on, starts the bridge, and walks you through the single Figma click (the manifest path is put on your clipboard). Afterwards, start the bridge with `start-bridge.bat`, and follow [TESTING.md](TESTING.md) for the live-app checklist. `install.bat /uninstall` removes the panel.

Manually, on any platform:

```bash
# 1. install & build everything
npm install
npm run build

# 2. verify the core math
npm test

# 3. start the bridge (leave running)
npm run bridge
```

### Install the Figma plugin

1. `npm run build:figma` (already done by `npm run build`).
2. In the Figma **desktop** app: **Menu → Plugins → Development → Import plugin from manifest…**
3. Pick `packages/figma-plugin/manifest.json`.
4. Run **Plugins → Development → LazyLord**.

### Install the Adobe panel

Enable CEP debug mode and link the panel into your CEP extensions folder:

```bash
# Windows (PowerShell)
./tools/install-cep.ps1

# macOS
./tools/install-cep.sh
```

Restart the Adobe app, then open **Window → Extensions (legacy) → LazyLord**.

### Transfer from Figma

1. Bridge running, LazyLord panel open in your Adobe app (its dot turns green).
2. In Figma, select layers, open LazyLord, choose a target (or **All apps**), pick an **Image scale** (1x–4x, default 2x), press **Send**.
3. Watch the layers appear natively in the Adobe document. ✨

If everything you selected sits inside one top-level frame, it lands where it sits in that frame, and a new document or comp is created at the frame's size.

### Push and pull between Illustrator and After Effects

With the panel open in both apps, each one offers the other as a destination automatically.

- **Illustrator → AE:** select artwork, press **Push**. It is rebuilt as native AE shape, text and footage layers, positioned where it sat on the artboard.
- **AE → Illustrator:** select layers, press **Pull**. Shape layers come back as editable Illustrator paths, text as live text on its real baseline, and footage as your original linked file.

### Options: Layout and Hierarchy

Both the Figma plugin and the Adobe panel have a folded **Options** section. The sender chooses; the receiving app obeys (they travel as `document.options`). Choices are remembered per app.

The Figma plugin also has a **Destination** choice, shown above Options:

| Destination | What the receiving app does |
| --- | --- |
| **New document — frame or object size** (default) | A new Photoshop / Illustrator document or After Effects comp. A whole frame or section gets one its size and name; objects get one their own size and name. |
| **New document — top-level frame size** | A new document the size of the top-level frame the selection sits in, with everything where it sits in that frame. |
| **Open document** | Into the document or comp already open, where it sits in its frame (a new one only when nothing is open). |

With either **New document** choice, selecting several whole frames or sections sends each one separately: every frame gets its own document or comp, at its size and under its name. A frame sent whole is always the page, even without a fill, so its contents keep their place in it.

Transfers pushed from Illustrator or pulled from After Effects always go into the open document or comp, as before.

| Option | Choice | What the receiving app builds |
| --- | --- | --- |
| **Layout** | **Split** (default) | One layer per shape |
| | **Combine** | After Effects: every eligible shape in **one** shape layer, one vector group each. Text, images, gradient-filled shapes and shapes with a different clip stay separate layers (reported). Illustrator and Photoshop ignore it. |
| **Hierarchy** | **Flatten** (default) | Groups dissolve into their layers; a group's opacity is multiplied into its layers (reported when they could overlap) |
| | **Groups** | Illustrator groups, Photoshop layer groups, After Effects parent **nulls** — or nested shape groups when combining |

Split + Flatten is what earlier versions produced, with two intentional fixes (see *Behaviour changes in v0.4*).

After every transfer the panel prints a one-line summary (layers, images — originals vs. generated — and fallbacks by kind), and lists anything that needed a fallback, naming the object and the reason, sorted skipped → rasterized → approximated.

---

## What transfers

### Figma → Photoshop / Illustrator / After Effects

| Content | After Effects | Illustrator | Photoshop |
| --- | --- | --- | --- |
| Vector shapes (bezier) | Shape layer | Path / compound path | **Editable shape layer** (raster fill as fallback) |
| Rectangle / ellipse | **Live Rect / Ellipse shape** | Path | Shape layer |
| Solid fill & stroke | ✅ (weight/cap/join) | ✅ | ✅ stroke on the shape layer where possible |
| Linear / radial gradient | Gradient Ramp effect (2 stops) | **Native gradient**, direction and length | **Gradient fill layer** |
| Clipping frames & masks | Layer masks | Clipping group | Layer group with a vector mask |
| Frames & groups | Parent nulls / shape groups (*Groups*) | Groups (*Groups*) | Layer groups (*Groups*) |
| Frame backgrounds | Shape layer | Path | Shape layer |
| Live, editable text | ✅ | ✅ | ✅ |
| Font family + style | best-effort | best-effort | best-effort |
| Images / rasters | Footage | Placed image, embedded | Smart object |
| Rotation | ✅ about the centre | ✅ | ✅ |
| Opacity, position & size | ✅ | ✅ | ✅ |

Figma rotation used to pivot on the layer's top-left; vectors now have their transform baked into the geometry, and text and images turn about their centre on every host. Diagonal linear gradients keep the angle Figma shows, on non-square and rotated shapes too.

### Illustrator → After Effects

| Illustrator object | Becomes | Notes |
| --- | --- | --- |
| `PathItem` | AE shape layer | Full bezier fidelity; rectangles and ellipses become live Rect / Ellipse shapes |
| `CompoundPathItem` | One shape layer, even-odd | Holes are preserved |
| `GroupItem` | Parent null (*Groups*) or flattened | Group opacity carried |
| Clipping group | Layer masks on its contents | Nested masks keep the innermost (reported) |
| `TextFrame` (point text) | Editable AE text | On its **real** baseline, rotation carried |
| `TextFrame` (area text) | Editable AE text | Rebuilt as point text; the box is not carried over |
| `PlacedItem` (linked) | AE footage | Uses **your original file** — never re-encoded; rotation carried |
| `RasterItem` (embedded) | AE footage | Exported to `@2x` PNG |
| Mesh, symbol, live effect | AE footage | Rasterised via a scratch document, and reported |
| Linear / radial gradient | Gradient Ramp | Real gradient vector, including later transforms |
| RGB / CMYK / Gray / Spot | AE colour | CMYK converted through Illustrator's own engine |

### After Effects → Illustrator

| AE layer | Becomes | Notes |
| --- | --- | --- |
| Shape layer, drawn path | Illustrator path | Full bezier fidelity, tight bounds |
| Shape layer, rect / ellipse / polystar | Illustrator path | Parametric shapes are generated; polystar roundness is dropped and reported |
| Shape layer with several painted groups | A group of paths | Each group keeps its own fill/stroke; group opacity carried |
| Fill / stroke | Solid colour, width, cap, join, fill rule | Stroke width scales with the baked transform |
| Gradient Ramp effect | Gradient fill | So LazyLord's own AE gradients round-trip |
| Layer masks (Add) | Clipping group | Other mask modes, feather and inverted masks are reported |
| Text layer | Live Illustrator text | On its real baseline, rotation carried |
| Footage layer | Placed image | Uses **your original file**; rotation carried |
| Solid layer | Filled rectangle | A solid is just a coloured rect |
| Parented layers | Placed correctly | The whole parent chain is composed |
| Selected parent null | Group | Its selected children go inside |
| Track matte | — | Reported, not transferred |
| Camera, light, precomp, null | — | Skipped and reported |

### Assets

- **After Effects:** images LazyLord generated are copied next to your saved project in `LazyLord Assets/` (never overwriting; `-1`, `-2`… appended) and imported from there. In an unsaved project they stay in the temp folder, and the panel says so. Your own linked files are never copied.
- **Illustrator:** generated images are embedded; your own files stay linked.

## Behaviour changes in v0.4

- **Illustrator stacking order fixed.** The Illustrator reader used to send overlapping artwork upside down; it now sends it bottom-to-top like every other source.
- **After Effects paint order.** In split layout, strokes now draw over fills, as in the source.
- AE shape layers holding several painted groups now arrive as several shapes (they used to share the first fill).
- A new AE comp / Illustrator or Photoshop document is sized to the source artboard, comp or top-level Figma frame, not just the selection.

## Known limitations

- **After Effects gradients** come from the Gradient Ramp effect because scripts cannot set shape-layer gradient colours. A Ramp has two colours and no per-stop transparency: extra stops are dropped and uneven alpha is averaged, both reported. Gradient **strokes** become their first colour.
- **After Effects gradient fills cannot be read** from shape layers (only LazyLord's Gradient Ramps can); those shapes arrive unfilled, and the panel says so.
- **Photoshop gradients** longer than Photoshop's 150% scale limit are clamped (reported). Diagonal gradients on long, thin Figma shapes hit this.
- **Font mapping** relies on family/style name matching; unusual fonts may fall back to the host default.
- **Mixed-style text** is outlined (Figma) or flattened to its first character's style (Illustrator); per-character styling is not rebuilt.
- **Effects** (shadows, blurs, layer styles), blend modes and AE path operators (Merge, Trim, Repeater…) are not transferred; they are reported.
- A clip on a group (rather than on its layers) is not rebuilt by After Effects. No source produces one today.
- Combining shapes in After Effects may pull a shape above its neighbours when only some shapes in a Figma clipping frame carry the clip (reported).
- **Not yet implemented:** Photoshop → anywhere, anything → Figma, updating existing layers instead of appending, per-character text styling, effects.
- **Not verified in real apps.** Every host-API assumption was checked against documentation and forums only. The main ones:
  - the Gradient Ramp property names and the space its points use on shape layers;
  - Photoshop's ActionManager descriptors for shape, gradient and vector-mask layers;
  - whether setting `Layer.parent` in AE keeps the child's visual position;
  - the mapping of Illustrator's `GradientColor.matrix`.

---

## Development

```bash
npm run dev:figma        # rebuild the Figma plugin on change
npm run bridge           # run the bridge with logs
```

- **Debug the Figma UI**: right-click the plugin → *Open Console*.
- **Debug the Adobe panel**: open the port from `packages/adobe-cep/.debug` in Chrome (e.g. `http://localhost:8770`) for the panel's DevTools; ExtendScript `$.writeln` output goes to the ExtendScript Toolkit / VS Code debugger.
- **Change the port**: set `LAZYLORD_PORT` for the bridge and update `BRIDGE_URL` in `packages/figma-plugin/src/ui.ts`, `packages/adobe-cep/js/main.js`, and the Figma `manifest.json` `networkAccess`.

### Tests

The CEP side is plain ES3 and needs no build, so it is checked with Windows Script Host, whose JScript engine is the same language level ExtendScript targets. No install required:

```bash
cscript //Nologo tools\check-extendscript.js
```

That parses every `.jsx`/`.js` file in the panel and catches what modern editors accept but ExtendScript rejects — above all **trailing commas**, which throw at load time. The other suites run the real modules against mocked host DOMs:

```bash
cscript //Nologo tools\test-ae-builder.js
```
```bash
cscript //Nologo tools\test-ai-builder.js
```
```bash
cscript //Nologo tools\test-ps-builder.js
```
```bash
cscript //Nologo tools\test-illustrator-reader.js
```
```bash
cscript //Nologo tools\test-aftereffects-reader.js
```
```bash
cscript //Nologo tools\test-cep-panel.js
```

The core geometry and the Figma plugin's serialiser run under Node ≥ 22.7 with type stripping (the script copies the core sources to `.lazylord-tmp/` first):

```bash
node --experimental-transform-types tools/test-core.mjs
```

They pin down the maths that is otherwise invisible until something looks wrong on screen: y-flips, tangent signs, rotation direction and pivots, gradient handles, clip spaces, group order and opacity, and every fallback's diagnostic.

### Architecture notes

- The **IR** (`packages/core/src/ir.ts`) is the contract. Y is down everywhere (Figma/AE convention); Illustrator and Photoshop flip Y against the active artboard/canvas on the way in and out.
- A layer's geometry is in its **local** space (origin at its frame's top-left); frames, clip paths and group boxes are in **frame** space (selection-normalised). Vectors are always baked (rotation 0); text and images carry a clockwise rotation about their frame centre.
- Bezier tangents are stored **relative to their vertex** (After Effects `Shape` convention), so AE reconstruction is direct and other hosts add the anchor back. Converting a point and its handle *before* subtracting is what makes the y-flip come out right.
- **Groups** are structural: a group's children keep frames in the same frame space, so a target that does not rebuild hierarchy just flattens (`LazyLord.flattenLayers`).
- All SVG-path parsing (including arcs and quadratics → cubics) happens once in `packages/core/src/svg-path.ts`; ExtendScript only ever consumes plain numbers.
- `Document.originSpace` says whether `bounds` is a real page offset (`"document"`: Illustrator, After Effects, Figma inside one frame) or an arbitrary canvas point (`"canvas"`). Only the former is added back when placing, and only then does `Document.canvas` size a new document or comp.
- Every conversion that is not native records a diagnostic (`approximated`, `rasterized` or `skipped`) naming the object and the reason.
- A host that can push ships a **reader** module registered in `READ_MODULE` in `js/main.js`. Adding one is how the remaining directions get built.

## License

MIT — see `LICENSE`.
