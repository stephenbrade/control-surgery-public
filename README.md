# Control Surgery: supplementary website

Static GitHub Pages site for Control Surgery morph examples — cherry-picked,
random, baseline comparisons, and ablations. Same structure and styling as
`lmdm-public`, plus an α-slider morph player with waveform views.

## Layout

```
index.html              page sections
styles.css              site + morph-player styles
morph.js                the α-slider player (no edits needed to add examples)
scripts.js              audio exclusivity, copy-cite, missing-figure fallback
data/examples.json      the one file you edit to add examples
audio/morphs/<method>/<example_id>/step_00.wav ... step_10.wav
images/overview.png     method figure (auto-hidden if absent)
tools/build_manifest.py scan audio/morphs and update examples.json
tools/make_placeholders.py synth stand-in audio so the page is testable
```

## Adding real examples

1. Render 11 steps per (method, example) into
   `audio/morphs/<method>/<example_id>/step_00.wav` … `step_10.wav`
   (α = 0 is `step_00`, α = 1 is `step_10`; a different step count is fine —
   set `steps` in the manifest).
2. `python3 tools/build_manifest.py --group random --match 'random_*'`
   to pick the new directories up.
3. Fill in `source_prompt`, `target_prompt`, `tier` (`one-shot` /
   `multi-shot`) and `ops` for each new entry in `data/examples.json`.
   `ops` entries render as code chips: `{"op": "brightness", "arg": "p90"}`.
4. `python3 tools/make_placeholders.py --clean` once real audio is in, to
   delete any leftover stand-ins.

Method keys and their display labels live in `methods` at the top of
`data/examples.json`. An example whose `methods` has more than one key is
rendered as a side-by-side comparison grid; a single key renders as one
full-width player.

Sections pick up examples by `group` via
`<div data-morph-group data-group="cherrypicked">` in `index.html`. Optional
attributes: `data-methods="control_surgery,echoedit"` to restrict/order
methods, `data-limit="6"`, `data-example="whoosh_fast_airy"`, `data-compact`.

## The morph player

- Slider steps through α; audio is decoded to `AudioBuffer`s so switching
  steps mid-playback swaps sources at the same playhead with an ~18 ms
  equal-power crossfade — no restart, no click.
- Big waveform: current step, colour interpolating source-blue → target-orange.
  Click to seek.
- **All steps**: every α step's waveform side by side — click one to jump to it.
- **Envelopes**: RMS envelopes of all steps overlaid, coloured by α. This is
  the view that shows how the morph reshapes the sound over time.
- Files that are missing 404 quietly and the player says which directory to
  drop them into, so the page is safe to publish half-filled.

## Placeholder audio

`python3 tools/make_placeholders.py` writes a synthetic whoosh morph into every
directory the manifest names, so sliders and waveforms are demonstrable before
any real renders exist. It never overwrites directories that already contain
`.wav` files it did not generate.

## Local preview

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. (Must be served over HTTP — `file://` blocks the
`fetch` of `data/examples.json`.)

## Publish on GitHub Pages

1. Push to `https://github.com/stephenbrade/control-surgery-public`.
2. **Settings → Pages → Source**: Deploy from a branch, `main`, `/ (root)`.
3. Site URL: `https://stephenbrade.github.io/control-surgery-public/`.

For an anonymous review copy, mirror to a fresh throwaway org as with
`lmdm-anon-submission`, and strip the author block in `index.html`.
