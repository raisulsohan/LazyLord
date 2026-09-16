# LazyLord

**Move vectors, live text and images between Figma, Photoshop, Illustrator and After Effects — any of them to any other.**

LazyLord is an open, self-hostable alternative to [Battle Axe Overlord](https://battleaxe.co/overlord). Select layers anywhere, press **Send**, and they are rebuilt as **native** shape layers, path items, text layers and images in the app you sent them to — not flattened screenshots.

> Status: **v1.0 — packaged.** All four hosts both send and receive, with the same options
> everywhere: where the transfer lands and at what size, how it is laid out, whether it adds
> layers or updates the ones an earlier transfer built, plus blend modes and effects. Update,
> conflict detection and **Live** sync now work in all four, not just After Effects and
> Illustrator. The bridge runs inside the panel — no window to keep open — and the panel ships
> as a signed `.zxp` that installs with a double-click, so a user needs neither Node nor an
> extension manager.
>
> Everything is covered by mocked-host test suites. v0.7 has been run in the real apps; **the
> v0.8–v1.0 additions have not been yet** — TESTING.md lists what to check, and host-API
> behaviour marked *unverified* below is the first thing to look at.

---

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

## Install

Grab `LazyLord-<version>.zip` from the [releases page](../../releases), unzip it, and run
**Install LazyLord.bat** (macOS: **Install LazyLord (macOS).command**). That is the whole
install: the panel inside is signed, so nothing else is needed — no Node.js, no extension
manager, no debug switch. Then open it with **Window → Extensions (legacy) → LazyLord** in
Photoshop, Illustrator or After Effects.

For the Figma half, the zip carries the plugin: in the Figma **desktop** app, **Plugins →
Development → Import plugin from manifest…** and pick `Figma plugin/manifest.json`. (Once the
plugin is on Figma Community that step goes away.)

Cutting a release is [PUBLISHING.md](PUBLISHING.md); in short, `npm run release:cert` once and
`npm run release` each time.

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
# Windows (PowerShell)
./tools/install-cep.ps1

# macOS
./tools/install-cep.sh
```

Restart the Adobe app, then open **Window → Extensions (legacy) → LazyLord**.

## What talks to what

Every app both sends and receives, so all twelve directions work:

| sends ↓ / receives → | Figma | Illustrator | After Effects | Photoshop |
| --- | --- | --- | --- | --- |
| **Figma** | — | ✅ | ✅ | ✅ |
| **Illustrator** | ✅ | — | ✅ | ✅ |
| **After Effects** | ✅ | ✅ | — | ✅ |
| **Photoshop** | ✅ | ✅ | ✅ | — |

What each app can *describe* still differs — After Effects has no inner shadow, Illustrator has
no timeline, Photoshop's layer styles are not written — and every one of those gaps is
reported on the transfer rather than left to be discovered. The tables under
[What transfers](#what-transfers) say which.

---

### Transfer from Figma

1. Bridge running, LazyLord panel open in your Adobe app (its dot turns green).
2. In Figma, select layers, open LazyLord, choose a target (or **All apps**), pick an **Image scale** (1x–4x, default 2x), press **Send**.
3. Watch the layers appear natively in the Adobe document. ✨

If everything you selected sits inside one top-level frame, it lands where it sits in that frame, and a new document or comp is created at the frame's size.

### Sending from an Adobe app

Every panel has a **Send selection** card. It lists every other app that is connected, and the button says where the transfer is going — **Send to After Effects**, **Send to Figma**, and so on.

> Earlier versions labelled these **Push** and **Pull**, following Overlord. Those words name a
> direction through a workflow rather than what the button does — After Effects' button said
> "Pull" while sending artwork *out* — and they stop meaning anything once every app talks to
> every other one. The button now simply names its destination.

The panel has the same **Destination** and **Image scale** choices the Figma plugin does, so a
transfer out of Illustrator can make a new comp the size of the artboard exactly as one out of
Figma can:

| Destination | What the receiving app does |
| --- | --- |
| **Open document** (default) | Into the document or comp already open, where it sits on the page |
| **New — source page size** | A new document or comp the size of the source artboard / composition / canvas, with everything where it sits on it |
| **New — selection size** | A new document or comp the size of the selection, with the artwork at its origin |

### Options: Layout, Hierarchy, Existing and Keyframes

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
| **Existing** | **Add** (default) | Every transfer creates new layers |
| | **Update** | A layer an earlier transfer built from the same object is edited where it stands, instead of a duplicate being added |
| **Keyframes** | **Auto** (default) | While updating: a property that is already animated gets a new key at the playhead; a still one is just set |
| | **Always** | Every property LazyLord updates is keyed at the playhead — how you animate a shape by re-sending it |
| **On conflict** | **Overwrite** (default) | While updating: a layer that was edited in the receiving app since it was last sent is updated anyway, and reported |
| | **Keep my edits** | That layer is left as it was edited, and reported |
| **Only what changed** | on (default) | While updating: only the layers whose source changed since the last successful send to that app go out; nothing at all when nothing changed |

Split + Flatten + Add is what earlier versions produced, with two intentional fixes (see *Behaviour changes in v0.4*).

#### Shape updating

Each layer a transfer builds records where it came from — the source app, the source **document** and the object's own id — in the one writable text field its host gives every layer (an After Effects layer **comment**, an Illustrator **note**). The tag is a single bracketed token, so anything else you keep in that field survives:

```
my own note
[[LazyLord figma|0:1|1:42]]
```

With **Existing: Update**, the receiving app reads those tags back and edits the matching layer instead of adding one. What that changes:

| | After Effects | Illustrator |
| --- | --- | --- |
| What is rewritten | The transform, the outline and the paint — found by searching the layer's contents, not assumed to still be where they were left | The artwork is rebuilt and dropped into the stacking position the old item held; the old item is removed |
| What survives | Its place in the stack, its parent, its effects, its masks, and any property LazyLord does not own | Its place in the stack and the layer or group it was in |
| What does not | — | Anything added to the item itself, such as an Illustrator appearance |
| Keyframes | Animated properties take a key at the playhead rather than a static value, which is what makes re-sending an edited shape animate it | No timeline, so none |

**Photoshop and Figma update the way Illustrator does**: the new version is drawn where the old one stood — same layer group or frame, same place in the stack — and the old one is removed. Their tags live where the user never sees them: in each Photoshop layer's **XMP metadata** (saved in the PSD; not the Background layer), and in each Figma node's **plugin data** (saved in the file). Both keep a fingerprint too, so a layer edited there since the last send is a conflict, as in After Effects and Illustrator. In Figma, a node moved into another frame or group is updated where it now is; only the current page is searched.

Notes worth knowing:

- **The first transfer always adds** — there are no tags to match yet. Send once, then switch to Update.
- **Update ignores Layout and Hierarchy** (reported). Editing layers where they stand cannot also restructure them; send with Add to change the layout.
- **Update needs somewhere to update**, so it always builds into the open document or comp — in the Figma plugin it overrides Destination, and says so.
- **A layer id only matches within its own document.** Node ids, Illustrator `uuid`s and After Effects layer ids all repeat across files, so the document key is part of the tag. An unsaved source has no stable key; its tags match only other keyless ones.
- **Nothing is ever deleted in After Effects.** If a shape no longer holds what the source describes — you added a contour, or deleted a group — the contours that pair up are updated and the mismatch is reported.
- Deleting the tag from a layer's comment or note detaches it: the next Update adds a fresh layer instead.

#### Smart diff, conflicts and Live

- **Smart diff.** Every leaf sent is fingerprinted from its IR. After a successful send the fingerprints are kept per destination app and source document (the Adobe panels in their local storage, the Figma plugin while it is open), and an update leaves out every leaf whose fingerprint has not changed. The paths of images LazyLord generated are not part of it, since they change on every read. An update never deletes, so after deleting a layer in the destination, untick **Only what changed** once to send everything again.
- **Conflicts.** When a build or an update finishes, After Effects and Illustrator add a fingerprint of what LazyLord wrote to the tag — `[[LazyLord figma|0:1|1:42~k3f9.2a]]` — and the next update compares it with the layer as it is now. After Effects reads the transform, outline, paint, text and footage (an animated property by its keys, a still one by its value before expressions, so neither the playhead nor an expression counts as an edit); Illustrator the geometry, points, paint, text and linked file of the items made from one layer. **On conflict** decides what happens to a layer that differs. Tags written before fingerprints never conflict and gain one on their next update.
- **Live needs one destination**: any single app — After Effects, Illustrator, Photoshop or Figma — but not "All apps", whose apps can each hold something different.
- **Live.** Tick **Live — send changes as you work** under the Send button. In Figma, the objects selected at that moment are watched (the page's `nodechange` event, debounced by 600 ms) and exported again when anything inside them changes. In the Adobe panels, a cheap stamp of the selection (`LazyLord.liveStamp`: AE's selected layers and their fingerprints, Illustrator's selected items, Photoshop's history state and selected layers) is polled every 1.5 s. Each change goes as an update of only what changed, into the open document; a change made while a send is under way waits for it. Live sends are logged but kept out of the history. It stops by itself when what it watches is gone, or the bridge or destination disconnects.

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

### Blend modes and effects

A layer's blend mode and its shadows and blurs travel with it, in one shared vocabulary
(`BlendMode` and `Effect` in `packages/core/src/ir.ts`). What a host cannot rebuild it reports,
naming the layer and what was lost — it is never dropped quietly.

| | Figma | After Effects | Illustrator | Photoshop |
| --- | --- | --- | --- | --- |
| **Blend modes** (all 16) | ✅ native | ✅ native | ✅ native | ✅ native |
| **Drop shadow** | ✅ native | ✅ Drop Shadow effect | reported | reported |
| **Shadow spread** | ✅ native | reported | reported | reported |
| **Inner shadow** | ✅ native | reported | reported | reported |
| **Layer blur** | ✅ native | ✅ Gaussian Blur | reported | reported |
| **Background blur** | ✅ native | reported | reported | reported |

Worth knowing:

- **After Effects describes a shadow differently.** It has no x/y offset — it has a direction
  dial and a distance — so the IR's offset is converted into them. Its Drop Shadow also has no
  spread, so a shadow that uses one is rebuilt without it and says so.
- **A blur radius is not the same number everywhere.** Figma's radius is a standard deviation;
  AE's Blurriness is roughly twice it for the same look, and is converted.
- **Illustrator live effects and Photoshop layer styles are not rebuilt.** Both live in
  ActionManager with parameters that do not line up with anyone else's, so approximating them
  would be guesswork. They are reported instead.
- **A rasterised layer keeps its effects in its pixels**, so its effects are deliberately *not*
  sent as well — otherwise every shadow would be drawn twice. Its blend mode still travels,
  because an export renders the layer, not how it composites with what is under it.
- A blend mode a host does not have leaves the layer Normal, reported.

## Behaviour changes in v0.4

- **Illustrator stacking order fixed.** The Illustrator reader used to send overlapping artwork upside down; it now sends it bottom-to-top like every other source.
- **After Effects paint order.** In split layout, strokes now draw over fills, as in the source.
- AE shape layers holding several painted groups now arrive as several shapes (they used to share the first fill).
- A new AE comp / Illustrator or Photoshop document is sized to the source artboard, comp or top-level Figma frame, not just the selection.

## In-depth review (v0.8.1)

Four independent reviews (builders, readers, panel + bridge, Figma + core) turned up about sixty defects; the confirmed ones are fixed, with regression tests. The ones that matter most:

- **Security:** the bridge refused nothing — any web page could connect, receive transfers or push files into a panel, and a transfer id could name a folder outside the temp directory. Now only LazyLord's own clients connect, and ids are made safe before they touch the disk.
- **Wrong target:** the Figma plugin gave every file the same source key (`figma.root.id` is `"0:0"` everywhere), so an Update from one file could overwrite layers sent from another. Each file now gets its own key, kept in its plugin data. Illustrator could tag — and a later Update remove — the user's own artwork on a layer above the active one.
- **Update:** After Effects wrote comp-space values into parented layers (they jumped), relinked images to the temporary folder, dropped mixed text styles, failed on keyed fonts, reset gradient opacity, left LazyLord's own clip masks behind, and updated a duplicate instead of the original.
- **Readers:** blend modes never left After Effects, Illustrator or Photoshop; Photoshop group clips were in the wrong space, shape layers lost strokes and got holes where contours overlapped, and a send changed the user's layer selection; Illustrator ignored spot-colour tints and cropped rasterised strokes; After Effects ignored reversed shape direction and sent a whole PSD for one of its layers.
- **Smart diff and Live:** moving a whole selection, or fading a group, was not seen as a change; a failed live send was never retried; Reconnect started an endless reconnect loop; Live and Send could overlap; a Figma page-sized frame received artwork piled in its corner, rotated images off-centre and clipped layers unclipped.

## Reliability, history and presets

- **All or nothing.** If a build stops part-way with an error, what it had made is taken back:
  - **After Effects:** new layers and project items are removed. They are matched by id, so the user's own are never touched.
  - **Illustrator:** new items are removed by uuid, and a document the transfer opened is closed unsaved.
  - **Photoshop:** the document steps back to its history state before the build, so Redo can bring it back.

  Anything that cannot be identified is left alone, and the error says so. Per-layer fallbacks still give a partial build with diagnostics, as before. Layers an *Update* had already edited stay edited (use Undo). Figma builds are not rolled back yet.
- **Large transfers** (JSON over 4 MB, usually because of images) travel in 1 MB chunks that the receiver joins back together, staying well under the bridge's 100 MB message limit.
- **Temporary files.** Transfer folders in `<temp>/lazylord` older than 7 days are removed when a panel starts. Until then, an After Effects project that was never saved still links its generated images from there.
- **History.** The Adobe panels and the Figma plugin keep the last 25 transfers sent and received: when, where to or from, what, how many layers, and any fallbacks or failure. It is kept per app, and can be cleared.
- **Presets.** The Options section can save the Destination, Image scale and options under a name and bring them back in one step.

## Known limitations

- **After Effects gradients** come from the Gradient Ramp effect because scripts cannot set shape-layer gradient colours. A Ramp has two colours and no per-stop transparency: extra stops are dropped and uneven alpha is averaged, both reported. Gradient **strokes** become their first colour.
- **After Effects gradient fills cannot be read** from shape layers (only LazyLord's Gradient Ramps can); those shapes arrive unfilled, and the panel says so.
- **Photoshop gradients** longer than Photoshop's 150% scale limit are clamped (reported). Diagonal gradients on long, thin Figma shapes hit this.
- **Font mapping** relies on family/style name matching; unusual fonts may fall back to the host default.
- **Mixed-style text** travels as runs (font, size, colour, tracking per range) and is rebuilt as live text; After Effects needs 24.3 or newer for it (`TextDocument.characterRange`), and older versions take the first run's style, reported.
- **Effects:** blend modes travel everywhere, and After Effects rebuilds drop shadows and layer blurs; other effects, layer styles and AE path operators (Merge, Trim, Repeater…) are not transferred, and are reported.
- A clip on a group (rather than on its layers) is not rebuilt by After Effects. No source produces one today.
- Combining shapes in After Effects may pull a shape above its neighbours when only some shapes in a Figma clipping frame carry the clip (reported).
- **Updating into Photoshop rests on layer XMP.** Photoshop layers have no comment or note, so the tag is written to each layer's XMP metadata (through AdobeXMPScript when it loads, else as a small XMP packet of its own). A pixel edit that changes neither bounds, opacity, blend, text nor fill colour is not seen as a conflict.
- **Updating does not restructure.** Layout and Hierarchy are ignored while updating, and an Illustrator update replaces the item rather than editing it, so an appearance added to that item in Illustrator goes with it.
- **An After Effects gradient is not updated.** Its colours are written to the underlying solid fill, but the Gradient Ramp effect is left as it was (reported). Re-send with Add for a gradient that changed.
- **Figma cannot read a file**, so anything sent there travels as bytes rather than as a path — the panel reads the file and embeds it. A transfer that reaches Figma with only a path (from a host that could not read it) reports the image rather than dropping it silently.
- **Photoshop can only read its selection through ActionManager.** If that call fails, only the active layer is sent, reported. Its shape layers also need both a vector mask and a readable fill colour; without either, the layer is rasterised instead.
- **Not yet implemented:** Illustrator live effects and Photoshop layer styles.
- **Updating into Figma** searches only the current page, and does not roll a failed build back.
- **Live in the Adobe panels polls.** CEP gives a panel no change events, so the selection is stamped every 1.5 s. Illustrator reads at most 500 selected items and a few thousand path points per poll (bounds past that); After Effects does not treat a playhead move as a change, so values that only change by scrubbing are not re-sent.
- **Not verified in real apps.** Every host-API assumption was checked against documentation and forums only. The main ones:
  - the Gradient Ramp property names and the space its points use on shape layers;
  - Photoshop's ActionManager descriptors for shape, gradient and vector-mask layers;
  - whether setting `Layer.parent` in AE keeps the child's visual position;
  - the mapping of Illustrator's `GradientColor.matrix`;
  - that `AVLayer.comment` and `PageItem.note` persist in a saved project/document and survive a round trip (the whole mapping engine rests on this), and that the values the conflict fingerprint reads back are unchanged by a save and reopen;
  - that `PageNode.on("nodechange")` fires for the edits Live watches, with the node's parents readable;
  - that a Photoshop layer's `xmpMetadata.rawData` can be written by a script and is kept in the saved PSD;
  - that `Property.setValueAtTime` on a shape path and a Text Document behaves as the scripting guide describes, and that `numKeys` reads back as expected;
  - that Illustrator's `document.pageItems` really does reach nested items (the mocked tests only cover top-level artwork), and that `PageItem.move(..., ElementPlacement.PLACEBEFORE)` puts an item directly in front of the reference;
  - that `FootageSource.replace` relinks a layer without disturbing its transform;
  - Photoshop's `targetLayers` ActionManager call and its Background-layer index offset, and that a shape layer's vector mask really does appear in `document.pathItems` once that layer is active;
  - the AE effect match names and control indices for Drop Shadow and Gaussian Blur, and that its shadow dial is measured clockwise from straight up;
  - that a Figma plugin can create the nodes the builder asks for — `createVector` with `vectorPaths`, `createImage`, `figma.group` — and that `isMask` on the first child of a group clips the rest.

---

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

## License

MIT — see `LICENSE`.

---

## The interface

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
