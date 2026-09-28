# If something goes wrong

**Whatever stops you, email me: [lettertosohan@gmail.com](mailto:lettertosohan@gmail.com?subject=LazyLord%20problem).**
Tell me what happened in detail and I will sort it out. Most of what is below
you can fix in a minute without writing to anyone.

*This describes LazyLord 1.1.11.*

---

## Contents

- [Start here](#start-here)
- [Installing and opening the panel](#installing-and-opening-the-panel)
- [Connecting](#connecting)
- [Sending and receiving](#sending-and-receiving)
- [Artwork arrived wrong](#artwork-arrived-wrong)
- [Updating in place](#updating-in-place)
- [Live](#live)
- [Messages you may see](#messages-you-may-see)
- [Reading the Fallbacks card](#reading-the-fallbacks-card)
- [Reporting a problem](#reporting-a-problem)
- [Questions people ask](#questions-people-ask)

---

## Start here

Four checks answer most problems:

1. **Is a LazyLord panel open in an Adobe app, with a green dot?** That panel
   is the bridge. Nothing else — including Figma — can send or receive
   without one.
2. **Did you restart the Adobe app after installing?** Adobe only looks for
   new panels while it starts up.
3. **Is the Figma plugin open?** A transfer into Figma waits in the plugin, so
   with the plugin closed there is nothing to hold it.
4. **What does the Log say?** Open **Log** in the panel. It usually names the
   problem in one line, and the **Fallbacks** card above it lists anything a
   host could not rebuild.

---

## Installing and opening the panel

| What you see | What to do |
| --- | --- |
| **LazyLord is not in the Window menu** | Restart the app. Adobe only looks for new panels while it starts up. In Photoshop the menu is **Window → Extensions (legacy)**; that is Adobe's own name for this kind of panel, and nothing is wrong. |
| **The panel opens blank** | Run **`Fix a blank panel.bat`** from the download folder and restart the app. On macOS, in Terminal: `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`. Adobe's signature check fails on some machines; this tells it to load the panel anyway. |
| **The installer did nothing, or the panel is an old version** | Unzip the download first — do not run the installer from inside the zip — close all three Adobe apps, and run `1 - Install LazyLord` again. |
| **macOS refuses to open the installer** | Right-click it and choose *Open*, then confirm. |
| **Figma cannot import the plugin** | Figma only imports development plugins in the **desktop app**. Run `2 - Add the Figma plugin` first: it puts the manifest path on your clipboard for the file dialog. |

---

## Connecting

| What you see | What it means |
| --- | --- |
| **The dot stays grey** (*Connecting…*, then *Bridge offline*) | Nothing is serving port 7878, or something else is holding it. Close every panel, start one Adobe app, and open LazyLord there alone. Press **Reconnect** if it does not come back by itself. |
| **The dot was green and went grey** | The app that was hosting the bridge quit. Another panel takes the port over on its next attempt — a few seconds — or press **Reconnect**. |
| **Figma says it cannot connect** | Open a LazyLord panel in Photoshop, Illustrator or After Effects first. In a browser, allow Figma to reach apps on this device if it asks. Safari never allows it: use Chrome, Edge, Firefox or the desktop app. |
| **"The built-in bridge is missing (run install.bat again)"** | The panel was installed from an old build without `js/relay.js`. Install the current release again. A stand-alone bridge (`start-bridge.bat`) also works in the meantime. |
| **The other app is not listed under Send to** | Only connected apps are listed. Open the LazyLord panel there too; the list updates by itself. |

---

## Sending and receiving

| What you see | What to do |
| --- | --- |
| **Send is greyed out** | No other app is connected, or a send is still running (the button says *Sending…*). In Figma it also waits for a selection — the button says which is missing. |
| **"No response from … after 20 s"** | The receiving app is busy rebuilding, or showing a dialog. The panel frees the button but keeps waiting: a reply within five minutes is still reported, marked as a late reply. |
| **Nothing arrived, and the sender says auto-receive is off** | Tick **Auto-receive** in the receiving app's panel and send again. |
| **Nothing arrived in Figma** | Look at the plugin: the transfer is waiting under **Incoming**. Press **Place on canvas**. |
| **"Nothing changed since the last send"** | You are updating with **Only what changed** on, and nothing did. Untick it to send everything again — do that after deleting layers in the destination, since an update never deletes. |
| **"Save the After Effects project first"** | The transfer brings in images, and After Effects links footage rather than embedding it. Save the project (the images go in a `LazyLord Assets` folder beside it), or pick a folder under **Images → Choose…** in the After Effects panel. Nothing was added. |
| **A build failed part-way** | What it had made is taken back automatically — new layers and items are removed, or Photoshop steps back to its history state from before the build. Layers an *Update* had already edited stay edited; use Undo. |
| **"The host scripts are not loaded yet"** | The app was busy or still starting when the panel opened. Press **Send** (or send again): the panel loads them once more. If it keeps failing, the log names the file and line. |
| **"Preferences cannot be stored here"** | The panel's storage is locked down on this machine. Everything still works; the options simply reset when the panel closes. |
| **Photoshop, or the whole computer, freezes while a big document is sent** | Every layer that has to travel as a picture — a pixel layer, a smart object, a rasterised effect layer — is exported through a scratch document its own size, and Photoshop is busy until that is done. Since 1.1.11 one image is kept under 30 megapixels and a transfer under 300, so a big old PSD no longer asks for gigabytes at once; if you are on an older version, update. On any version: send fewer layers at a time, choose **1x** under Image scale, and rasterise only what has to be. |

---

## Artwork arrived wrong

Open the **Fallbacks** card first — the answer is usually already there,
naming the object and what happened to it. Beyond that:

| What you see | Why |
| --- | --- |
| **A shape arrived as a picture** | It could not be described natively: a Photoshop smart object or effect-laden layer, an Illustrator mesh or symbol, a Figma layer marked *Send the selected layers as images*, or a shape whose outline could not be read. The card says which. |
| **A shape arrived unfilled** | It came from an After Effects shape layer with a gradient fill you made yourself; scripts cannot read those colours. LazyLord's own gradients do come back. |
| **Text arrived in the wrong font** | The font is not installed, or its style name does not match. The card names the font. |
| **Text lost its mixed styles in After Effects** | Mixed character styles need After Effects 24.3 or newer. |
| **A paragraph text box became point text** | Area and paragraph text are rebuilt as point text everywhere; the box is not carried over. |
| **A shadow looks different in After Effects** | After Effects has no shadow spread, and describes the offset as a direction and a distance. Both are reported. |
| **A gradient looks shorter in Photoshop** | Photoshop clamps a gradient past its 150% scale limit. Diagonal gradients on long, thin shapes hit this. |
| **Layers are in the wrong place** | If the selection was not inside one top-level frame, Figma has no page origin to give, so the artwork lands at the target's own origin. Send the whole frame, or choose a **New document** destination. |
| **A group's opacity was applied to every layer** | That is **Hierarchy: Flatten**. Choose **Groups** (or **Precomps** in After Effects) to keep the group and its opacity. |

The whole per-route reference is in [What transfers](transfers.md).

---

## Updating in place

| What you see | Why |
| --- | --- |
| **Update added copies instead of updating** | The first transfer always adds — there are no tags to match yet. Send once, then switch to Update. Tags also only match within the document they came from: a source that was never saved has no stable key. |
| **Update did not restructure the layers** | Layout and Hierarchy are ignored while updating, and it is reported. Send with **Add** to change the layout. |
| **Update went into the open document although I chose New** | Update needs something to update, so it always builds into the open document or comp. The Options section says so. |
| **"Was changed in After Effects since it was last sent"** | You edited that layer by hand. **On conflict** decides: *Overwrite* replaces your edits, *Keep my edits* leaves the layer alone. Either way it is listed. |
| **A layer stopped being updated** | Its tag was removed from the layer comment or note — deleting the tag detaches the layer on purpose. The next update adds a fresh one. |
| **After Effects reported a contour mismatch** | The shape no longer holds what the source describes (a contour added, a group deleted). Nothing is ever deleted in After Effects: the contours that pair up are updated and the difference is reported. |

---

## Live

| What you see | Why |
| --- | --- |
| **"Live stopped: no destination app is connected"** | The app Live was feeding disconnected. Reconnect it and switch Live on again. |
| **Live will not start with All apps** | Live keeps *one* app in step; each app could otherwise hold something different. Choose a single destination. |
| **Live changes are not showing in Figma** | They are waiting in the plugin's **Incoming** card, which always holds the newest state. Press **Update on canvas**. |
| **Scrubbing the After Effects timeline changes nothing** | The stamp Live watches reads keys, not the value at the playhead, so moving the playhead is not an edit. |
| **A huge Illustrator selection updates coarsely** | Live reads at most 500 items and a few thousand path points per poll, so the poll never stalls Illustrator. |
| **A frame sequence does not follow Live** | *Layers as frames* is a one-off send. |

---

## Messages you may see

A few lines from the log, and what they mean:

| Message | Meaning |
| --- | --- |
| *Connected to LazyLord bridge.* | The panel reached the bridge — its own, or another panel's. |
| *Host modules loaded (ae + reader).* | The ExtendScript side is ready to send and receive. |
| *Large transfer: sent in 6 pieces.* | Over 4 MB of JSON, usually images; it travels in 1 MB pieces the receiver joins back together. |
| *A large transfer arrived damaged and was dropped.* | Pieces went missing on the way. Send again. |
| *Declined a transfer from Figma (auto-receive off).* | This panel is set not to receive; the sender was told. |
| *N unchanged layers not sent again.* | **Only what changed** left them out. |
| *Removed 3 transfer folders older than 7 days from the temp folder.* | Routine cleaning at start-up. Nothing depends on those folders by then. |
| *Rebuilt in After Effects: 12 layers created · 3 images (1 original, 2 generated) · fallbacks: 2 approximated / 0 rasterized / 1 skipped* | The one-line summary of a finished transfer. "Original" images are your own files, used in place; "generated" ones LazyLord made. |
| *LazyLord 1.2.0 is available (this panel is 1.1.10).* | The update check found a newer release. |
| *Could not check for updates: GitHub answered 403.* | Shown only for a check you asked for, and only when the fallback failed too: GitHub's API limit (60 requests an hour per internet address) was reached *and* the release page could not be read either. Ordinarily the fallback answers and you see nothing. Try again later. |
| *Exported at 0.79x rather than 2x: at 2x it would be 16000 x 12000 px (192 MP)…* (Fallbacks card) | The layer was too big to export at the scale you chose, so it went at a lower one. It is still placed at its full size; only its resolution dropped. Send it on its own at 1x if it must be sharper. |
| *Left out: this transfer already carries 300 MP of generated images…* (Fallbacks card) | The transfer's share of pictures was used up before this layer. Send fewer layers at once, or send this one on its own. |

---

## Reading the Fallbacks card

Every line is one object and one thing that happened to it:

```
Hero illustration — No vector description for this kind of layer (shape with
text), so it was sent as an image        rasterized
```

- **skipped** — it did not arrive. Worth acting on.
- **rasterized** — it arrived as a picture. Fine if it never has to be
  edited; if it does, simplify it in the source app and send again.
- **approximated** — it arrived, but not exactly. Usually a detail one app
  has and another does not.

The card covers the whole transfer: what the sending app could not describe
and what the receiving app could not rebuild. It lists the worst first.

---

## Reporting a problem

Email **[lettertosohan@gmail.com](mailto:lettertosohan@gmail.com?subject=LazyLord%20problem)**
or [open an issue](../../../issues). The more of this you send, the faster it
is fixed:

- which apps and versions — *After Effects 2025, Photoshop 2024, Windows 11*;
- the LazyLord version, which is beside the logo in the panel;
- what you selected, what you pressed, and what you expected to happen;
- a screenshot of both apps;
- the text from the panel's **Log** and its list of fallbacks.

Nothing in the log is sent anywhere by LazyLord; it is yours to copy.

---

## Questions people ask

**Is it really free?**
Yes. MIT licensed — free to use, at work too, and free to change.

**Does my work leave my computer?**
No. The apps talk to each other over your own machine's loopback address, the
same way a local preview server works. There is no server, no account and no
telemetry. Unplug the internet and it still works. The one thing the panel
fetches is the number of the newest release on GitHub, about twice a day, and
unticking **Check for updates** stops that.

**Do I need Overlord, Node.js, or an extension manager?**
No. The download is self-contained.

**Will it touch my existing layers?**
Only if you ask. **Add** always makes new layers. **Update** replaces what
LazyLord itself made earlier, and if you have edited one of those layers by
hand it tells you and does what **On conflict** says.

**Can I use it with Figma in the browser?**
Yes, in Chrome, Edge or Firefox, once the plugin is installed from Figma
Community — a plugin added from the download runs only in the desktop app. If
the browser asks whether figma.com may reach apps on this device, allow it;
that is the LazyLord panel. Safari blocks it.

**Do I have to keep a panel open?**
Yes, one, in any Adobe app. It is the bridge. There is no separate program and
no console window.

**Can several apps receive at once?**
Yes — the Figma plugin's **All apps** sends to every connected app. Live is the
exception: it keeps one app in step.

**Where do the images go?**
Illustrator embeds them and Photoshop places smart objects, so nothing is left
behind. After Effects links footage, so generated images are copied into a
`LazyLord Assets` folder beside your saved project, or into a folder you pick
in the panel.

**Windows and macOS both?**
Yes. The installer for each is in the download.
