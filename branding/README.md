<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Branding

Your server's own images for micaOS. Everything in this folder is served to the
phone, and a micaOS update never replaces an image here: the release ships only
this README and the empty `wallpapers` folder.

## Wallpapers

Put wallpaper images in `branding/wallpapers/`. Players can pick them in
Settings alongside the built-in ones. Use `png`, `jpg`, `jpeg` or `webp`.

## Boot logo

Put a logo anywhere under `branding/`, then point `mica_brand_logo` at it in
`server.cfg`, relative to this resource:

```cfg
set mica_brand_logo "branding/logo.svg"
```

Use `png`, `jpg`, `jpeg`, `webp` or `svg`.

Restart the resource after adding or changing a file: FiveM lists the files it
serves when the resource starts.
