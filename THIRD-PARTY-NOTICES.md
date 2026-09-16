# Third-party notices

## AEUX

LazyLord's After Effects builder gives a shape layer's Gradient Fill and
Gradient Stroke their colours by writing a small animation preset (.ffx) and
applying it. The fixed part of that preset — the chunks naming the property
path down to a gradient's Colors, and the chunks around the colour data — is
taken from the preset templates in AEUX, which solved the same problem first.
The colour data itself, and the sizes of every chunk, are written by LazyLord
(`packages/adobe-cep/jsx/ae.jsx`, `LazyLord._ae_presetBytes`).

- Project: AEUX — https://github.com/google/AEUX
- Copyright Google LLC
- Licensed under the Apache License, Version 2.0:
  https://www.apache.org/licenses/LICENSE-2.0
