# The Figma Community listing, ready to paste

Everything the publish form asks for. Copy each block as it is; the steps
around it are in [PUBLISHING.md](../PUBLISHING.md).

The two images are already the sizes Figma wants — **`assets/icon.png`**
(128×128) and **`assets/cover.png`** (1920×960). They are rendered from the
SVGs by `node tools/render-art.mjs`, so change the SVG and run that rather than
editing a PNG by hand.

---

## Name

```
LazyLord
```

## Tagline

```
Send artwork to Photoshop, Illustrator and After Effects as real, editable layers
```

## Description

```
Move vectors, live text and images from Figma into Photoshop, Illustrator and
After Effects — and back again. Everything arrives as real artwork: editable
Bézier paths, live text you can retype, proper layers and groups. Not a
flattened screenshot, and not an SVG you have to clean up.

Send again after a change and LazyLord updates what it built before, right
where it stands — your position, your grouping, your edits kept. If you have
edited one of those layers by hand it stops and asks which version to keep.

WHAT TRAVELS
• Bézier and compound paths, rectangles and ellipses as live shapes
• Live text, including per-character styling, with fonts matched by name
• Images at 1x to 4x
• Linear and radial gradients
• Masks and clipping frames, groups and hierarchy
• Blend modes, drop shadows and blurs
• Anything an app cannot rebuild is listed on the transfer — never dropped
  silently

BEFORE YOU START — the other half
This plugin talks to a free companion panel for Photoshop, Illustrator and
After Effects. Install that first, then come back:

  https://github.com/raisulsohan/LazyLord/releases/latest

Download the zip, unzip it, run "Install LazyLord.bat" (macOS: the .command
file), and open the panel with Window > Extensions (legacy) > LazyLord. It
takes about a minute and needs nothing else — no Node.js, no extension
manager, no account.

Two more things worth knowing:
• Use the Figma DESKTOP app. A browser tab cannot reach the apps on your
  computer, so the plugin cannot connect there.
• Keep one LazyLord panel open in an Adobe app while you work. That panel is
  what the plugin talks to.

PRIVACY
Nothing is uploaded. The plugin connects to ws://localhost:7878 — the LazyLord
panel running on your own machine — and nowhere else. There is no server, no
account and no analytics, and it works with the internet unplugged.

Free and open source (MIT). The code, the Adobe panel and the full
documentation are at https://github.com/raisulsohan/LazyLord

Built by Raisul Sohan — https://raisulsohan.com/
```

## Tags

Figma allows **five**, and offers a recommended list first. Two of those fit —
**Vector** and **Image**. PDF, HTML, Web, Figma to code and GIF do not: tagging
what a plugin cannot do disappoints whoever searched for it.

Spend the other three on **Add custom tags**, because people search by where
the artwork is going:

```
Illustrator
Photoshop
After Effects
```

No need for an "export" tag — the category already says Import & export, and
the slot is worth more as an app name.

## Support contact

```
https://github.com/raisulsohan/LazyLord/issues
```

---

## Where the Publish button is

Figma moved it out of the Plugins submenu. From the **desktop app**, with a
design file open (not the home screen):

1. Click the **Figma logo**, top-left.
2. **Plugins** → **Manage plugins** (older builds: *Plugins → Development →
   Manage plugins in development*).
3. Find LazyLord under **Development**, click the **⋯** beside it, and choose
   **Publish**.

If it is not in that list, the manifest has not been imported into this Figma
account — *Plugins → Development → Import plugin from manifest…* and pick
`packages/figma-plugin/manifest.json`.

## The pages the Publish modal asks for

| Page | What to put |
| --- | --- |
| **Describe your resource** | Category: **Design tools → Import & export** — that is what this does, and where people look for it. Name, tagline and description are above. |
| **Choose some images** | `assets/icon.png` and `assets/cover.png`. |
| **Data security** | The disclosure form — answers below. |

### Data security answers

Every one of these is simply true, and all of it is verifiable in the source.

- **Does the plugin collect or store user data?** No.
- **Does it send data to a server or third party?** No. The only address it
  contacts is `ws://localhost:7878`, which is the user's own computer.
- **Does it use analytics or tracking?** No.
- **Does it require an account, login or payment?** No.
- **Where does data go?** Between the Figma desktop app and the LazyLord panel
  running inside Photoshop, Illustrator or After Effects on the same machine.
  Nothing is uploaded, and it works with the internet disconnected.
- **Third-party services used?** None.

Review takes up to about two weeks, and the plugin sits under **Published**
with an **In review** badge until then.

---

## If the reviewer asks about network access

The manifest declares one domain and nothing else:

```json
"networkAccess": {
  "allowedDomains": ["ws://localhost:7878"],
  "reasoning": "LazyLord talks only to the local LazyLord bridge (ws://localhost:7878) to hand your selection to Photoshop, Illustrator and After Effects. No data leaves your machine."
}
```

`localhost` is the user's own computer. The plugin opens a WebSocket to the
LazyLord panel running inside Photoshop, Illustrator or After Effects, hands it
the selection, and gets back a report of what was built. No other address is
contacted, and with no panel open the plugin simply says so and does nothing.

The panel it talks to is open source and downloadable from the repository
above, so the whole path is inspectable.

## What a reviewer will see with no Adobe app installed

The plugin opens, says **"No Adobe app connected yet"**, tells them to open the
LazyLord panel, and links to the download. The Send button stays disabled and
names what is missing. Nothing errors and nothing is sent.
