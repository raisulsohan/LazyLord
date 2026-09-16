# The Figma Community listing, ready to paste

Everything the publish form asks for. Copy each block as it is; the steps
around it are in [PUBLISHING.md](../PUBLISHING.md).

The two images are already the sizes Figma wants — **`assets/icon.png`**
(128×128) and **`assets/thumbnail.png`** (1920×1080). They are rendered from the
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
• It works in the Figma desktop app and in Chrome, Edge or Firefox. If the
  browser asks whether Figma may reach apps on this device, allow it. Safari
  does not allow it.
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

## Before any of this: two-factor authentication

Figma refuses to publish from an account without it — the form says so in red at
the bottom and the Next button will not take you past it. Turn it on at
<https://www.figma.com/settings> under **Security**, with an authenticator app,
and keep the recovery codes somewhere safe.

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
| **Choose some images** | Icon: `assets/icon.png`. Thumbnail: `assets/thumbnail.png` — Figma asks for 1920×1080 here, not the 2:1 the README banner uses. The playground file is optional and LazyLord has no use for one: it needs an Adobe app open, which a shared Figma file cannot provide. |
| **Data security** | The disclosure form — answers below. |

### Data security answers

Five questions. Every answer below is a plain fact about the plugin, and all of
it can be checked in the source.

**1. Do you host a backend service for your plugin/widget?**
→ *No, I do not host a backend service for my plugin/widget.*

Nothing is hosted anywhere. The bridge LazyLord talks to runs on the user's own
computer, inside the Adobe panel they installed themselves.

**2. Does your plugin/widget make any network requests with services you do not
host?**
→ *My plugin/widget makes network requests not captured by the above*, with
this in the box:

```
LazyLord opens a WebSocket to ws://localhost:7878 — an address on the user's own
computer. That is the LazyLord panel running inside Photoshop, Illustrator or
After Effects, which the user installs themselves and which is open source. The
selection read from Figma's plugin API is sent there so the Adobe app can
rebuild it natively, and a report of what was built comes back. No remote server
is contacted, nothing is uploaded, and the plugin works with the internet
disconnected.
```

Do not tick "does not make any network requests": the manifest declares
`ws://localhost:7878`, and a reviewer comparing the two would be right to stop.
There are no static-asset or analytics requests — the UI is a single inlined
file and there is no telemetry of any kind.

**3. Does your plugin/widget use any user authentication?**
→ *No, my plugin/widget does not require or use any user authentication.*

**4. Do you store any data read/derived from Figma's plugin API?**
→ *Yes, my plugin/widget stores data read/derived from Figma's plugin API
locally (eg. localStorage, figma.clientStorage, or node.setPluginData).*

Two kinds, both local:

- `setPluginData` on the nodes a transfer builds — a tag saying which object in
  which document it came from, plus a fingerprint. That is what lets a later
  send update the node in place instead of dropping a second copy beside it.
- `figma.clientStorage` for the user's own settings: the chosen target, image
  scale, options, the recent-transfer list and saved presets.

Neither leaves the machine.

**5. How do you manage updates to your plugin/widget?**
→ *I am a solo developer. I manage and update my plugin/widget myself.*

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
