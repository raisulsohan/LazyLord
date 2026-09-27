# What transfers

What LazyLord can carry on each of the twelve routes, what it can only
approximate, and what it tells you about instead. The everyday side of this is
in [the manual](manual.md); this page is the reference.

*This describes LazyLord 1.1.10.*

---

## Contents

- [What a transfer carries](#what-a-transfer-carries)
- [The fallback ladder](#the-fallback-ladder)
- [The twelve routes](#the-twelve-routes)
- [Leaving Figma](#leaving-figma)
- [Leaving Illustrator](#leaving-illustrator)
- [Leaving After Effects](#leaving-after-effects)
- [Leaving Photoshop](#leaving-photoshop)
- [Arriving in each app](#arriving-in-each-app)
- [Text and fonts](#text-and-fonts)
- [Gradients](#gradients)
- [Blend modes and effects](#blend-modes-and-effects)
- [Masks and clipping](#masks-and-clipping)
- [Images](#images)
- [Colour](#colour)
- [Known limits](#known-limits)

---

## What a transfer carries

Nothing is exported as SVG or PSD and re-imported. The sending app describes
its selection in one host-neutral form — LazyLord's **IR** — and the receiving
app rebuilds it with its own native calls. One transfer holds:

| | |
| --- | --- |
| **Layers**, bottom to top | vectors, text, images, groups and (from Photoshop) adjustment layers |
| **A frame** per layer | position, size, a clockwise rotation about its centre, and opacity |
| **Paint** | solid fills and strokes, linear and radial gradients with every stop, stroke weight, cap, join, alignment and dashes |
| **Outlines** | bezier contours with tangents, a winding rule, and — where the outline is exactly one — a live rectangle or ellipse |
| **Text** | the characters, font family and style, size, colour, letter spacing, line height, alignment, case, decoration, kerning method and kerned pairs, per-character runs, and the real baseline where the source knows it |
| **Clips and masks** | a clip path shared by every layer one mask clips, a Photoshop clipping mask, and a greyscale layer mask |
| **Effects** | blend mode, drop and inner shadows, layer and background blur, and Photoshop's layer styles |
| **Structure** | groups, the page box a frame came from, and which component a group is an instance of |
| **The page** | the selection's bounds, the source page's size and name, and whether those coordinates mean anything to another app |
| **Identity** | the source app and a stable key for the source document, so a later update can find what it built |
| **Your choices** | the options set in the sending panel, which the receiving app obeys |
| **Optionally** | the page's ruler guides and the document's named colours |
| **Diagnostics** | everything the sending app could not describe natively |

Developers: the types are in `packages/core/src/ir.ts`, the envelope in
`packages/core/src/protocol.ts`, and the conventions are explained in
[development.md](development.md).

---

## The fallback ladder

Nothing is ever dropped silently. Every conversion that is not native is
recorded against the object it happened to, and both panels list them after
the transfer:

| Tag | Meaning | Example |
| --- | --- | --- |
| **skipped** | It did not arrive. | A camera sent from After Effects; a pattern fill in Illustrator. |
| **rasterized** | It arrived as a picture rather than editable artwork. | A Photoshop smart object; a Figma layer you marked to send as an image. |
| **approximated** | It arrived, but not exactly. | A shadow spread After Effects cannot draw; area text rebuilt as point text. |

Each entry names the object as you see it in the source app and says what
happened in plain language. The sending app's list and the receiving app's
list are shown together, worst first.

---

## The twelve routes

| sends ↓ / receives → | Figma | Illustrator | After Effects | Photoshop |
| --- | --- | --- | --- | --- |
| **Figma** | — | ✅ | ✅ | ✅ |
| **Illustrator** | ✅ | — | ✅ | ✅ |
| **After Effects** | ✅ | ✅ | — | ✅ |
| **Photoshop** | ✅ | ✅ | ✅ | — |

Every app both sends and receives. What each app can *describe* still
differs — After Effects has no inner shadow, Illustrator has no timeline,
Photoshop's own layer styles are not written on the way in — and every one of
those gaps is reported on the transfer.

---

## Leaving Figma

| In Figma | Sent as |
| --- | --- |
| Rectangle, ellipse, polygon, star, line, vector, boolean operation | A vector layer, with its transform baked into the contours; rectangles and ellipses also carry their live shape |
| Frame, group, component, component set, instance, section | A group, with its own opacity; a frame's fill and border are leaves inside it, below and above its contents |
| A component or an instance | A group that also names the component, so a target can share one precomp between copies |
| Text | Live text, with per-character runs |
| A layer with an image fill | An image at the chosen scale |
| A layer you marked **Send the selected layers as images** | One image of it exactly as it looks |
| A mask layer (`isMask`) | A clip on every sibling above it |
| A clipping frame | A clip on its contents |
| Hidden layers, slices | Left out |
| Anything with no vector description | An image, reported |

Reported on the way out, among others:

- a second or third visible fill or stroke (only the first is used);
- an image paint on a vector or a stroke;
- angular and diamond gradients (sent as radial), and elliptical radial
  gradients (sent round);
- a per-side stroke weight, and inside or outside stroke alignment (the Adobe
  hosts centre strokes);
- text that mixes fonts, sizes or other styles beyond what runs can carry — it
  is outlined to keep its look, or sent as an image;
- mirrored text (sent unmirrored), and a text stroke;
- effects with no equivalent elsewhere — noise, texture and glass;
- a blend mode no other app has;
- a rotated or mirrored top-level frame, which means the selection lands at
  the target's origin rather than where it sits.

---

## Leaving Illustrator

| Illustrator object | Sent as | Notes |
| --- | --- | --- |
| `PathItem` | Vector | Full bezier fidelity; an exact rectangle or ellipse also carries its live shape |
| `CompoundPathItem` | One vector, even-odd | Holes preserved. Picking one path out of a compound sends the whole compound |
| `GroupItem` | Group | With its own opacity; contents bottom to top |
| Clipping group | A clip on every leaf inside it | Nested masks keep the innermost, reported |
| `TextFrame` (point text) | Live text | On its real baseline, rotation carried |
| `TextFrame` (area text) | Live text | Rebuilt as point text; the box is not carried, reported |
| `PlacedItem` (linked) | Image | **Your original file**, never re-encoded; rotation carried |
| `RasterItem` (embedded) | Image | Exported at the chosen scale |
| Mesh, symbol, live effect | Image | Rasterised through a scratch document, reported |
| Linear / radial gradient | Gradient | The real gradient vector, including later transforms |
| RGB / CMYK / Gray / Spot | Colour | CMYK converted through Illustrator's own engine; spot tints honoured |

Reported: pattern fills (the object arrives unfilled), gradient midpoints
moved off centre, an off-centre radial highlight, an elliptical radial
gradient, vertical text (rebuilt horizontal), a slanted or mirrored object, a
layer's or an unselected parent group's opacity, and a clipping path's own
fill and stroke. Illustrator's own live effects are not read yet, and are
reported.

---

## Leaving After Effects

| AE layer | Sent as | Notes |
| --- | --- | --- |
| Shape layer, drawn path | Vector | Full bezier fidelity, tight bounds |
| Shape layer, rect / ellipse / polystar | Vector | Parametric shapes are generated; polystar roundness is dropped and reported |
| Shape layer with several painted groups | A group of vectors | Each group keeps its own fill and stroke; group opacity carried |
| Fill / stroke | Solid colour, width, cap, join, fill rule | Stroke width scales with the baked transform |
| Gradient Ramp effect | Gradient | So LazyLord's own AE gradients round-trip |
| Layer masks (Add, Difference) | A clip | Other modes, feather, expansion, mask opacity and inversion are reported |
| Text layer | Live text | On its real baseline, rotation carried |
| Footage layer | Image | **Your original file**; rotation carried |
| Solid layer | Filled rectangle | A solid is a coloured rect |
| Parented layers | Placed correctly | The whole parent chain is composed |
| A selected parent null | A group holding its selected children | Chains of nulls nest |
| Track matte | — | Reported, not transferred |
| Camera, light, precomp, null with nothing under it, adjustment and guide layers | — | Skipped and reported |

Reported: a 3D layer (flattened to its 2D position and Z rotation), a path
operator such as Merge, Trim or Repeater (the raw paths are sent), a mirror or
skew a turned box cannot hold, video footage (only stills travel), one layer
of a layered file, footage with no file on disk, a second Gradient Ramp, and a
null whose children are not next to each other in the stack (it becomes one
group per unbroken run).

**After Effects gradient fills you made yourself cannot be read** from shape
layers — scripts cannot read their colours. LazyLord's own gradients can,
because it notes their stops in the layer comment. Shapes with an unreadable
gradient arrive unfilled, and the panel says so.

---

## Leaving Photoshop

| Photoshop | Sent as | Notes |
| --- | --- | --- |
| Shape layer | Vector | Needs both a vector mask and a readable fill colour; without either it is rasterised, reported |
| Text layer | Live text | Turned or slanted text is sent upright; paragraph text becomes point text, both reported |
| Pixel layer, smart object | Image | The layer as it looks, its styles baked in |
| Gradient fill layer | Gradient | Every stop |
| Layer group | Group | A group's own layer mask is reported, not transferred |
| Clipping mask | A `clipTo` on the clipped layers | The base layer stays visible |
| Layer mask | A greyscale mask image | |
| Layer styles: drop / inner shadow, outer / inner glow, stroke, colour overlay, gradient overlay, satin, bevel & emboss | Effects on the layer | Pattern overlays and gradient- or pattern-filled strokes are reported |
| Adjustment layers: Brightness/Contrast, Levels, Hue/Saturation, Exposure, Vibrance, Invert, Threshold, Posterize, Black & White, Photo Filter, Color Balance | An adjustment layer | With its opacity, blend mode and mask |
| Adjustment layers: Curves, Gradient Map, Channel Mixer and the rest | — | Reported |
| **Layers as frames** (Options) | One image sequence | Each selected layer, or each layer in a selected group, bottom first; hidden layers count |

Reported: Levels or Hue/Saturation set per colour channel (only the master
travels), a Black & White tint, angle, reflected, diamond and noise gradients,
a gradient stop that follows the foreground or background colour, and a layer
clipped to something that was not sent.

**Photoshop can only read its selection through ActionManager.** If that call
fails, only the active layer is sent, reported.

---

## Arriving in each app

### Into After Effects

| Content | Becomes |
| --- | --- |
| Vector | Shape layer; rectangles and ellipses as **live Rect / Ellipse shapes** |
| Gradient | A **real shape gradient with every stop** (a two-colour Gradient Ramp if that fails, reported) |
| Text | Live text, with mixed character styles on 24.3+ |
| Image | Footage, from a folder beside the saved project |
| Image sequence | One footage item |
| Group (*Groups*) | A parent null, or a nested shape group when combining |
| Frame (*Precomps*) | A precomp its size; a component and its instances share one, with each copy's text and colours as **Essential Properties** |
| Photoshop clipping mask | An alpha track matte on the base layer |
| Photoshop layer mask | A luma track matte from the mask |
| Photoshop layer styles | The same **After Effects layer styles** — on shape, text, pixel and smart object layers alike |
| Photoshop adjustment layer | An **adjustment layer** with the matching effect, opacity, blend mode and mask |
| Clip path | Layer masks |

### Into Illustrator

| Content | Becomes |
| --- | --- |
| Vector | Path or compound path |
| Gradient | A native gradient, direction and length kept |
| Text | Live text on its baseline |
| Image | A placed image — generated ones embedded, your own files linked |
| Group (*Groups*) | An Illustrator group |
| Clip path | A clipping group |
| Shadows and blurs | Live effects you can edit in the Appearance panel |

### Into Photoshop

| Content | Becomes |
| --- | --- |
| Vector | An **editable shape layer** (a raster fill as a fallback, reported) |
| Gradient | A gradient fill layer |
| Text | Live text |
| Image | A smart object |
| Group (*Groups*) | A layer group |
| Clip path | A layer group with a vector mask |
| Shadows | Layer styles |
| Layer blur | A smart filter — the layer becomes a smart object, so both the blur and the shape or text inside stay editable |

### Into Figma

| Content | Becomes |
| --- | --- |
| Vector | A vector node |
| Gradient | A native gradient |
| Text | Live text |
| Image | An image fill — Figma cannot read a file, so the bytes travel with the transfer |
| Group | A Figma group |
| Clip path | A mask group |
| Photoshop layer mask | A luminance mask |
| Shadows, glows, stroke, colour overlay | The Figma effects that match |
| Adjustment layers | Reported — Figma has none |

---

## Text and fonts

- Text stays **live and editable** on every host.
- Font family and style are matched by name. A font that is not installed
  leaves the name in place where the host allows it, and is reported.
- **Mixed styles travel as runs** — font, size, colour and tracking per range.
  After Effects needs 24.3 or newer to rebuild them; older versions take the
  first run's style, reported.
- **Kerning:** the method (metrics, optical, none) travels, and so do letter
  pairs kerned by hand between Illustrator and After Effects (AE 24.3+).
  Photoshop's kerned pairs are not read and Photoshop does not rebuild them;
  Figma folds letter spacing in, which looks the same and always uses the
  font's own kerning.
- **Area and paragraph text becomes point text**, and the box is not carried
  over — from Illustrator, from Photoshop and from After Effects.
- Text that Figma cannot describe as runs is outlined (or sent as an image) so
  it still looks right, and says which it did.

---

## Gradients

- **Linear and radial** gradients travel with every stop and their real
  direction and length, including transforms applied after the gradient.
- **After Effects** builds a real shape gradient. Scripts cannot set a
  gradient's colours directly, so LazyLord writes them through a small
  animation preset it makes on the fly; if After Effects refuses that, the
  shape falls back to a two-colour Gradient Ramp, reported. The stops it used
  are noted in the layer comment so the gradient can be read back out.
- **Photoshop** clamps a gradient longer than its 150% scale limit, reported.
  Diagonal gradients on long, thin shapes hit this.
- Gradient **midpoints** and an **off-centre radial highlight** are not
  carried; each blend is evened out, reported.
- Angular, diamond, reflected and noise gradients have no shared form: they
  are approximated or rasterised, reported either way.

---

## Blend modes and effects

A layer's blend mode and its shadows and blurs travel in one shared
vocabulary.

| | Figma | After Effects | Illustrator | Photoshop |
| --- | --- | --- | --- | --- |
| **Blend modes** (all 16) | ✅ native | ✅ native | ✅ native | ✅ native |
| **Drop shadow** | ✅ native | ✅ Drop Shadow effect | ✅ Drop Shadow live effect (black) | ✅ Drop Shadow layer style |
| **Shadow spread** | ✅ native | reported | reported | ✅ the style's Spread |
| **Inner shadow** | ✅ native | reported | reported | ✅ Inner Shadow layer style |
| **Layer blur** | ✅ native | ✅ Gaussian Blur | ✅ Gaussian Blur live effect | ✅ Gaussian Blur smart filter |
| **Background blur** | ✅ native | reported | reported | reported |
| **Photoshop layer styles** | shadows, glows, stroke, colour overlay | ✅ as layer styles | reported | — |

Worth knowing:

- **After Effects describes a shadow differently.** It has no x/y offset but a
  direction dial and a distance, so the offset is converted into them. Its
  Drop Shadow has no spread, so a shadow that uses one is rebuilt without it
  and says so.
- **A blur radius is not the same number everywhere.** Figma's radius is a
  standard deviation; After Effects' Blurriness is roughly twice it for the
  same look, and is converted.
- **A rasterised layer keeps its effects in its pixels**, so its effects are
  deliberately not sent as well — otherwise every shadow would be drawn twice.
  Its blend mode still travels, because an export renders the layer, not how
  it composites with what is under it.
- A blend mode a host does not have leaves the layer Normal, reported.
- After Effects takes one of each layer style per layer; a second is reported.

---

## Masks and clipping

| Source | Becomes |
| --- | --- |
| Figma clipping frame, or a mask layer | A clip path on the layers it clips |
| Illustrator clipping group | A clip path on every leaf inside |
| After Effects layer masks (Add, Difference) | A clip path |
| Photoshop clipping mask | `clipTo` — an alpha track matte in AE, a mask group in Figma |
| Photoshop layer mask | A greyscale mask image — a luma track matte in AE, a luminance mask in Figma |

A clip becomes layer masks in After Effects, a clipping group in Illustrator,
a layer group with a vector mask in Photoshop and a mask group in Figma.
Nested masks keep the innermost one, reported. A clip on a group rather than
on its layers is not rebuilt by After Effects — no source produces one today.

An After Effects layer takes one track matte, so a Photoshop layer that has
both a layer mask and a clipping mask keeps one and reports the other.

---

## Images

- **Your own files are never copied or re-encoded.** A linked Illustrator
  image or an After Effects footage item travels by path, and the other app
  uses the original.
- Anything LazyLord generates — Figma bytes, a rasterised fallback, an
  embedded raster — is written as a PNG at the chosen **Image scale** (1x–4x,
  2x by default).
- **After Effects** copies generated images into `LazyLord Assets/` beside the
  saved project (or a folder you chose) and links them from there. A project
  that has never been saved stops the transfer with a message rather than
  linking footage from a temporary folder.
- **Illustrator** embeds generated images; **Photoshop** places them as smart
  objects; **Figma** receives the bytes themselves.
- **Image sequences** (Photoshop's *Layers as frames*) are copied into a
  folder of their own with their names kept, so After Effects reads them as
  one sequence. A target that cannot play a sequence places the first frame
  and says so.

---

## Colour

Everything travels as RGBA with an alpha channel. Illustrator converts CMYK,
Gray and spot colours through its own engine, tints included. Photoshop's
Lab-based settings (a Photo Filter colour, for instance) are converted where
they are read. A colour that cannot be read is reported rather than guessed.

---

## Known limits

- **After Effects gradient fills you made yourself cannot be read** from shape
  layers; those shapes arrive unfilled, reported.
- **Photoshop gradients** past its 150% scale limit are clamped, reported.
- **Font mapping** relies on family and style names; unusual fonts may fall
  back to the host default.
- **Mixed character styles** need After Effects 24.3; older versions take the
  first run's style.
- **Illustrator's own live effects are not read** when sending from
  Illustrator, and **AE path operators** (Merge, Trim, Repeater…) are not
  transferred. Both are reported.
- **Components share a precomp only with Precomps.** Copies that differ in
  size, layout, images or styled text get a precomp each ("Button 2"…).
  Essential Graphics needs After Effects 2019 or newer; without it, differing
  copies simply get their own precomp.
- **Adjustment layers only rebuild in After Effects**, and only the kinds
  listed above.
- **Layers as frames** is a one-off send: Live and Update keep layers in step,
  not sequences.
- **Combining shapes in After Effects** may pull a shape above its neighbours
  when only some shapes in a Figma clipping frame carry the clip, reported.
- **Updating into Photoshop rests on layer XMP**, so a pixel edit that changes
  neither bounds, opacity, blend, text nor fill colour is not seen as a
  conflict.
- **Updating does not restructure**: Layout and Hierarchy are ignored while
  updating, and an Illustrator update replaces the item rather than editing
  it, so an appearance added to that item goes with it.
- **Figma** cannot read a file, does not roll a failed build back, searches
  only the current page when updating, and places nothing until you press
  **Place on canvas**.
- **Figma in the browser** works in Chrome, Edge and Firefox once the plugin
  comes from Figma Community; Safari does not let a web page reach the panel.
