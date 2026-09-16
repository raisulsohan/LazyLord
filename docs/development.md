# Building LazyLord from source

You do **not** need any of this to use LazyLord — the release on the
[releases page](../../../releases) installs with a double-click. This is for
changing it.

## How it works

Figma plugins can only reach `localhost`, and Adobe apps script through CEP/ExtendScript. LazyLord connects them with a tiny local WebSocket relay — the bridge — which **runs inside the LazyLord panel**: the first panel opened in Photoshop, Illustrator or After Effects hosts it, so there is nothing to start and no window to keep open. If that app quits, the next panel to reconnect takes it over. Any connected app can send; the bridge routes a transfer to the chosen destination and the acknowledgement back to whoever started it.

```
┌────────────┐                     ┌─────────────────────────────────────────┐
│   Figma    │ ◄──── IR / ack ───► │  LazyLord panel (first one opened)      │
│  plugin    │                     │   └ bridge :7878 (Node, ws, loopback)   │ ◄─► other panels
└────────────┘                     └─────────────────────────────────────────┘
        every app sends and receives; the bridge routes by destination
```

1. **Figma plugin** reads the selection and serialises it to a host-neutral **IR** (intermediate representation): groups, bezier contours, paints, clip paths, live-text properties and PNG fallbacks. `packages/figma-plugin`
2. **Bridge** routes each transfer to its target app and each acknowledgement back to its originator. It accepts only LazyLord's own clients (the Figma plugin, CEP panels, local tools) — a web page open in a browser is refused. `packages/bridge` (`relay.ts`, bundled into the panel as `js/relay.js`; `server.ts` runs it stand-alone)
3. **Adobe CEP panel** (one panel, three hosts) rebuilds incoming IR natively, and serialises its own selection to send out. `packages/adobe-cep`
4. **Core** holds the shared IR types, the transfer protocol, the SVG-path → bezier math and the pure geometry (transform baking, gradient handles, artboard detection) used by every side. `packages/core`

Everything runs on your machine — **no data leaves localhost.**

---

## Repository layout

```
lazylord/
├── packages/
│   ├── core/           # IR types, protocol, SVG-path → bezier, geometry helpers (TS)
│   ├── ui-kit/         # the one stylesheet both front ends wear
│   ├── figma-plugin/   # Figma plugin: selection ⇄ IR over WebSocket (TS + esbuild)
│   ├── bridge/         # Local WebSocket relay (Node + ws)
│   └── adobe-cep/      # CEP panel for PS/AI/AE (HTML/JS + ExtendScript)
│       ├── js/main.js  #   panel: bridge client, send flow, options, diagnostics
│       └── jsx/        #   ae/ai/ps builders + ae-read / ai-read / ps-read (readers)
├── tools/
│   ├── install-cep.ps1              # install the panel for dev (Windows)
│   ├── install-cep.sh               # install the panel for dev (macOS)
│   ├── sync-ui-css.mjs              # copies ui-kit/lazylord.css into the panel
│   ├── check-extendscript.js        # ES3 syntax check (needs only cscript)
│   ├── test-ae-builder.js           # AE builder vs. a mocked AE DOM
│   ├── test-ai-builder.js           # Illustrator builder vs. a mocked AI DOM
│   ├── test-ps-builder.js           # Photoshop builder vs. mocked ActionManager/DOM
│   ├── test-illustrator-reader.js   # Illustrator reader vs. a mocked AI DOM
│   ├── test-aftereffects-reader.js  # AE reader vs. a mocked AE DOM
│   ├── test-photoshop-reader.js     # Photoshop reader vs. mocked ActionManager/DOM
│   ├── test-cep-panel.js            # CEP panel vs. mocked CSInterface/WebSocket
│   ├── test-core.mjs                # core geometry + Figma plugin vs. a mocked scene (Node)
│   ├── test-bridge.mjs              # the relay over real sockets (Node)
│   └── smoke-test.mjs               # path-parser checks against the built core
└── package.json        # npm workspaces
```

---

## Prerequisites

*(for building from source — a user installing the release needs none of this)*

- **Node.js 18+** and npm (for building the plugin/bridge)
- **Figma desktop app** (needed to run a local dev plugin that talks to localhost)
- One or more of **Photoshop / Illustrator / After Effects, 2021 or newer** (CEP 11)

## Quick start

**Windows, one step:** double-click `install.bat`. It checks Node.js (and offers to install it with winget), runs `npm install`, builds everything, links the Adobe panel into Photoshop, Illustrator and After Effects with CEP debug mode on, and walks you through the single Figma click (the manifest path is put on your clipboard). Then open the LazyLord panel in any Adobe app — it runs the bridge — and follow [TESTING.md](TESTING.md) for the live-app checklist. `install.bat /uninstall` removes the panel.

Manually, on any platform:

```bash
# 1. install & build everything (the bridge is bundled into the panel)
npm install
npm run build

# 2. verify the core math
npm test
```

`npm run bridge` (or `start-bridge.bat`) still runs the bridge on its own, for troubleshooting or with no Adobe app open; a panel finding the port taken simply uses it.

### Install the Figma plugin

1. `npm run build:figma` (already done by `npm run build`).
2. In the Figma **desktop** app: **Menu → Plugins → Development → Import plugin from manifest…**
3. Pick `packages/figma-plugin/manifest.json`.
4. Run **Plugins → Development → LazyLord**.

### Install the Adobe panel

Enable CEP debug mode and link the panel into your CEP extensions folder:

```bash

### Install the Figma plugin

1. `npm run build:figma` (already done by `npm run build`).
2. In the Figma **desktop** app: **Menu → Plugins → Development → Import plugin from manifest…**
3. Pick `packages/figma-plugin/manifest.json`.
4. Run **Plugins → Development → LazyLord**.

### Install the Adobe panel

Enable CEP debug mode and link the panel into your CEP extensions folder:

```bash

## Development

```bash
npm run dev:figma        # rebuild the Figma plugin on change
npm run bridge           # run the bridge stand-alone, with logs (the panel normally runs it)
npm run test:bridge      # the relay over real sockets
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
cscript //Nologo tools\test-photoshop-reader.js
```
```bash
cscript //Nologo tools\test-cep-panel.js
```
```bash
cscript //Nologo tools\test-rollback.js
```

The core geometry and the Figma plugin's serialiser run under Node ≥ 22.7 with type stripping (the script copies the core sources to `.lazylord-tmp/` first):

```bash
node --experimental-transform-types tools/test-core.mjs
```

They pin down the maths that is otherwise invisible until something looks wrong on screen: y-flips, tangent signs, rotation direction and pivots, gradient handles, clip spaces, group order and opacity, and every fallback's diagnostic. The Phase 3 suites cover the mapping engine end to end — tags surviving a user's own comment, ids from different files not matching, a second transfer editing rather than duplicating, keys landing at the playhead, and a reworked shape being reported rather than clobbered. The v0.6 ones add the Photoshop reader, the Figma builder (including a subpaths → SVG → subpaths round trip and gradient handles that survive the transform they are turned into), and that a shadow offset becomes the direction-and-distance dial After Effects actually uses.

### Architecture notes

- The **IR** (`packages/core/src/ir.ts`) is the contract. Y is down everywhere (Figma/AE convention); Illustrator and Photoshop flip Y against the active artboard/canvas on the way in and out.
- A layer's geometry is in its **local** space (origin at its frame's top-left); frames, clip paths and group boxes are in **frame** space (selection-normalised). Vectors are always baked (rotation 0); text and images carry a clockwise rotation about their frame centre.
- Bezier tangents are stored **relative to their vertex** (After Effects `Shape` convention), so AE reconstruction is direct and other hosts add the anchor back. Converting a point and its handle *before* subtracting is what makes the y-flip come out right.
- **Groups** are structural: a group's children keep frames in the same frame space, so a target that does not rebuild hierarchy just flattens (`LazyLord.flattenLayers`).
- All SVG-path parsing (including arcs and quadratics → cubics) happens once in `packages/core/src/svg-path.ts`; ExtendScript only ever consumes plain numbers.
- `Document.originSpace` says whether `bounds` is a real page offset (`"document"`: Illustrator, After Effects, Figma inside one frame) or an arbitrary canvas point (`"canvas"`). Only the former is added back when placing, and only then does `Document.canvas` size a new document or comp.
- Every conversion that is not native records a diagnostic (`approximated`, `rasterized` or `skipped`) naming the object and the reason.
- A host that can push ships a **reader** module registered in `READ_MODULE` in `js/main.js`. Adding one is how the remaining directions get built.
- **Identity** is `source app | source document | layer id`, built by `LazyLord.tagKey` and stored on the built layer by the host's own means. `Document.sourceKey` carries the middle part: without it, ids from different files would collide. The tag helpers in `lazylord.jsx` are host-agnostic; only reading and writing the field is per-host, which is what a Photoshop implementation would have to solve.
- An update **writes what LazyLord owns and searches for it first** (`_ae_findParts`) rather than trusting the structure it left behind, so a layer the user has since reworked is reported instead of clobbered.

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
cscript //Nologo tools\test-photoshop-reader.js
```
```bash
cscript //Nologo tools\test-cep-panel.js
```
```bash
cscript //Nologo tools\test-rollback.js
```

The core geometry and the Figma plugin's serialiser run under Node ≥ 22.7 with type stripping (the script copies the core sources to `.lazylord-tmp/` first):

```bash
node --experimental-transform-types tools/test-core.mjs
```

They pin down the maths that is otherwise invisible until something looks wrong on screen: y-flips, tangent signs, rotation direction and pivots, gradient handles, clip spaces, group order and opacity, and every fallback's diagnostic. The Phase 3 suites cover the mapping engine end to end — tags surviving a user's own comment, ids from different files not matching, a second transfer editing rather than duplicating, keys landing at the playhead, and a reworked shape being reported rather than clobbered. The v0.6 ones add the Photoshop reader, the Figma builder (including a subpaths → SVG → subpaths round trip and gradient handles that survive the transform they are turned into), and that a shadow offset becomes the direction-and-distance dial After Effects actually uses.

### Architecture notes

- The **IR** (`packages/core/src/ir.ts`) is the contract. Y is down everywhere (Figma/AE convention); Illustrator and Photoshop flip Y against the active artboard/canvas on the way in and out.
- A layer's geometry is in its **local** space (origin at its frame's top-left); frames, clip paths and group boxes are in **frame** space (selection-normalised). Vectors are always baked (rotation 0); text and images carry a clockwise rotation about their frame centre.
- Bezier tangents are stored **relative to their vertex** (After Effects `Shape` convention), so AE reconstruction is direct and other hosts add the anchor back. Converting a point and its handle *before* subtracting is what makes the y-flip come out right.
- **Groups** are structural: a group's children keep frames in the same frame space, so a target that does not rebuild hierarchy just flattens (`LazyLord.flattenLayers`).
- All SVG-path parsing (including arcs and quadratics → cubics) happens once in `packages/core/src/svg-path.ts`; ExtendScript only ever consumes plain numbers.
- `Document.originSpace` says whether `bounds` is a real page offset (`"document"`: Illustrator, After Effects, Figma inside one frame) or an arbitrary canvas point (`"canvas"`). Only the former is added back when placing, and only then does `Document.canvas` size a new document or comp.
- Every conversion that is not native records a diagnostic (`approximated`, `rasterized` or `skipped`) naming the object and the reason.
- A host that can push ships a **reader** module registered in `READ_MODULE` in `js/main.js`. Adding one is how the remaining directions get built.
- **Identity** is `source app | source document | layer id`, built by `LazyLord.tagKey` and stored on the built layer by the host's own means. `Document.sourceKey` carries the middle part: without it, ids from different files would collide. The tag helpers in `lazylord.jsx` are host-agnostic; only reading and writing the field is per-host, which is what a Photoshop implementation would have to solve.
- An update **writes what LazyLord owns and searches for it first** (`_ae_findParts`) rather than trusting the structure it left behind, so a layer the user has since reworked is reported instead of clobbered.


## The interface: one stylesheet, two hosts

Both front ends wear one stylesheet, `packages/ui-kit/lazylord.css`. The Figma plugin inlines it
at build time (Figma only loads a single HTML file); the Adobe panel links a copy that
`npm run build` syncs into `packages/adobe-cep/css/`. **Edit the source, never the copy** — the
copy carries a "generated" banner and git ignores it.

Only the colours differ, and only because the hosts do: the plugin reads Figma's own light/dark
theme variables, while a CEP panel has no theme to read and Adobe expects dark, so the panel
re-declares the same tokens. Everything else — the section labels, the chip rows, the option
disclosure, the fallback list — is the same component in both.

Two things stay different on purpose: the panel shows what the plugin has no use for (which host
it is running in, a running log, the auto-receive switch), and the plugin has a resize grip the
panel does not need.

### Resizing

- **The Figma plugin** has a grip in its bottom-right corner. A plugin window is only ever the
  size the plugin asks for — there is no chrome to drag — so the grip *is* the chrome: drag it and
  the window resizes, down to 300 × 360 and up to whatever Figma allows. The size is remembered
  and restored next time you open the plugin.
- **The Adobe panel** is resized the way every Adobe panel is, by dragging its edge — between
  240 × 240 and whatever your display allows.

  > A CEP panel will not grow past its `<Size>` unless the manifest also declares a `<MaxSize>`.
  > Leaving it out is why the panel was once stuck at 300 × 360 however hard its edge was
  > dragged; `packages/adobe-cep/CSXS/manifest.xml` now declares one, and a test asserts it
  > stays there. **CEP only reads the manifest when the host app starts**, so a change to it
  > needs a full restart of Photoshop, Illustrator or After Effects — `install.bat` links the
  > panel with a junction, so there is nothing to reinstall.

Either way the layout reflows rather than overflowing: the Send-to and Image-scale rows are
`auto-fit` grids, so they go from one column at the narrowest to as many as fit, and stop growing
past a readable width instead of stretching a handful of chips across a wide window.


## Host-API assumptions still to be confirmed

Everything here was checked against Adobe and Figma documentation and developer
forums rather than by instrumenting the host, so each is a place a bug could
hide.

What is no longer on this list, because it has been run in the real apps: that
a layer tag survives a save and reopen — `AVLayer.comment`, `PageItem.note` and
a Photoshop layer's `xmpMetadata.rawData` — that the values the conflict
fingerprint reads back are unchanged by that round trip, and that
`PageNode.on("nodechange")` fires for the edits Live watches. The whole mapping
engine rested on the first of those.

The rest:
- the Gradient Ramp property names and the space its points use on shape layers;
- Photoshop's ActionManager descriptors for shape, gradient and vector-mask layers;
- whether setting `Layer.parent` in AE keeps the child's visual position;
- the mapping of Illustrator's `GradientColor.matrix`;
- that `Property.setValueAtTime` on a shape path and a Text Document behaves as the scripting guide describes, and that `numKeys` reads back as expected;
- that Illustrator's `document.pageItems` really does reach nested items (the mocked tests only cover top-level artwork), and that `PageItem.move(..., ElementPlacement.PLACEBEFORE)` puts an item directly in front of the reference;
- that `FootageSource.replace` relinks a layer without disturbing its transform;
- Photoshop's `targetLayers` ActionManager call and its Background-layer index offset, and that a shape layer's vector mask really does appear in `document.pathItems` once that layer is active;
- the AE effect match names and control indices for Drop Shadow and Gaussian Blur, and that its shadow dial is measured clockwise from straight up;
- that a Figma plugin can create the nodes the builder asks for — `createVector` with `vectorPaths`, `createImage`, `figma.group` — and that `isMask` on the first child of a group clips the rest.

New in 1.1, and not yet run in the real apps:
- **Real AE gradients:** that `layer.applyPreset` with only a G-Fill's or G-Stroke's Colors property selected writes that property alone, from a preset whose head is taken from AEUX and whose sizes are patched; the byte offsets live in `_ae_presetBytes`.
- **Track mattes:** `AVLayer.setTrackMatte` (AE 23) and the older layer-above `trackMatteType`, including that a duplicated base keeps its place.
- **AE layer styles:** that `app.executeCommand` with 9000–9008 adds Drop Shadow … Stroke to the selected layer of the comp in the viewer, and the `dropShadow/color`-style match names inside them.
- **AE adjustment effects:** the match names and control indices in `_ae_ADJUSTMENTS` (Brightness & Contrast 2, Easy Levels2, Hue/Saturation, Exposure2, Vibrance, Invert, Threshold2, Posterize, Black & White, Photo Filter, Color Balance 2), and Levels taking 0..1.
- **Photoshop ActionManager:** the `layerEffects` keys, the adjustment descriptors (`c:Brgh`, `c:Adjs` lists, Lab colours in Photo Filter), `hasUserMask`/`userMaskEnabled` and loading a mask as a selection.
- **Essential Graphics:** `Property.addToMotionGraphicsTemplateAs` (16.1) for Source Text and a shape Fill Color, and that a precomp layer's overrides are reached as `layer.property("ADBE Layer Overrides").property(name)` and take `setValue` — a TextDocument for text.
- **Kerning:** that a character's kerning in Illustrator (`TextRange.kerning`) and After Effects (`CharacterRange.kerning`, 24.3) is the space *before* it, that `TextDocument.autoKernType` (24.0) and `AutoKernType` exist under those names, and Photoshop's `TextItem.autoKerning`. If Adobe stores a kern on the character before the gap, only Figma is affected: its letter spacing lands one pair early.
- **Figma:** `getMainComponentAsync` under dynamic-page access, `getStyledTextSegments(["openTypeFeatures"])`, `setPluginData` on a selected instance, and that Chrome's local-network permission lets the plugin iframe reach `ws://localhost`.
- **Image sequences:** that `ImportOptions.sequence` with `forceAlphabetical` imports numbered PNGs as one item, and `FootageSource.conformFrameRate`; that `Folder.selectDlg` / `Folder.selectDialog` opens a folder picker from a CEP `evalScript`.

---

Packaging a release of your own is described in [PUBLISHING.md](../PUBLISHING.md).