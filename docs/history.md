# How LazyLord got here

Notes kept while it was built — what changed, and what an audit of the code
turned up.

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

## Image size limits (v1.1.11)

The first bug report from a user: a big old PSD sent from Photoshop to Illustrator, with its effect layers rasterised, hung the whole computer. Every layer that travels as a picture is exported through a scratch document its own size at the Image scale asked for, and nothing capped it — a layer the size of a large canvas at 2x was a hundred-megapixel document that Photoshop built and saved and Illustrator then embedded, once per layer.

Now one generated image is kept under 30 megapixels (12,000 px a side) by lowering its scale, below 1x when it must, and the generated images of one transfer together under 300 megapixels, after which the rest are left out. The layer keeps its full size on the page; only its resolution drops, and every case is reported. The limits live once in `lazylord.jsx` for the Photoshop and Illustrator readers (masks and frame sequences included) and once in `packages/core/src/images.ts` for the Figma plugin, with the same numbers.
