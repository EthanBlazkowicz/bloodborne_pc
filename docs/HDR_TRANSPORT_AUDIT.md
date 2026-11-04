# Native+ transport: the chain read out of the code (2026-11-04)

Written before re-running the harness, to separate what the code proves from what only a run can
measure. Read with `HDR_TONE_CURVE_ORDER.md` (whose "the upscaler clamps" conclusion the first
section below corrects) and `HDR_TONE_CURVE_PORT.md` (the mechanism).

Head: `866ba4c` on `hdr-nativeplus-port`.

## The chain, with the images it uses

```
game composite (extended curve, shader/native/tone_curve.cpp)
  -> scene targets at render size, RGBA16F proxies            scene_resolution.cpp / raster_targets.cpp
  -> transfer decode -> linear BT.2020, RGBA16F               hdr_upscale_transfer.comp (BB_TRANSFER_*
  -> reconstruction (DLSS / TAA / FSR 4 / FSR 1) -> output    vk_temporal_upscaler.cpp RunScaled
  -> transfer encode: excess = chain (>1 kept), result clamped hdr_upscale_transfer.comp (encode side)
  -> ui image at output size, then the game's UI draws        upscaler_ui.cpp EnsureUiResources
  -> display copy -> display image, output size, RGBA16F      upscaler_redirect.cpp RedirectColor
  -> present: blit to hdr_game (RGBA16F), hdr_output.frag     presenter.cpp RecordHdrPresent
  -> swapchain A2B10G10R10 + ST2084, or R16G16B16A16F scRGB
```

## Per stage: does a value above 1 survive?

| Stage | Format | Survives? | Evidence |
|---|---|---|---|
| composite target | RGBA16F proxy | yes | `HDR chain draw ... float target yes`; the extension writes to `2^log2(peak)` |
| transfer decode | RGBA16F | yes | clamps only to ±`BB_FP16_MAX`, then to ≥0 for BT.2020 |
| DLSS | RGBA16F in/out | **to confirm** | the driver's own HDR handling; its input is linear by design |
| TAA | RGBA16F in/out | **to confirm** | `taa.comp` clamps positions, depth and the history box, not the value |
| FSR 4 | RGBA16F in/out | **to confirm** | `fsr4_color.comp` clamps on decode; `fsr4_encode` writes the result back |
| FSR 1 | RGBA16F | **to confirm** | spatial filter over the float view |
| transfer encode | RGBA16F | yes | `excess_out` gets the value unclamped, on purpose |
| ui image | the guest LDR target's format (8-bit) | **no** | `EnsureUiResources(ow, oh, color.info.pixel_format, ...)` |
| display image | RGBA16F | yes | created from `Native16Format` |
| present blit target | RGBA16F | yes | `hdr_game` from `Native16Format` |
| `hdr_output.frag` | PQ / FP16 | to the peak | `min(linear, peak_white)` (no longer gated on `FLAG_EXCESS`) |

The ui image being 8-bit is by design: that is the image the game's UI draws into, and white is the
top of its range. The light above white does not travel through it — it travels in the excess image,
which the present samples separately and applies by scaling.

## Numbers the code predicts

`peak_white = hdr_peak / hdr_paper_white`; the extension's top in the chain's gamma 2.2 domain is
`peak_white`, and the present decodes once, scales by `top / brightest`, and stops at `peak_white`.

| paper white | peak | dark frame max | bright frame max |
|---|---|---|---|
| 203 | 790 | 202.9 nits | 790 nits (`3.8916^2.2 = 19.87` decoded, then `min(..., 3.8916)`) |
| 80 | 790 | 80 nits | 790 nits (`9.875^2.2 = 152.5`, then `min(..., 9.875)`) |

A dark frame is untouched because `top == brightest` skips the scale entirely.

## The log lines that confirm each hop

One run, `BB_HDR_SCENE_CURVE=1`, and these five say where the chain is:

```
HDR tone curve: fragment 5e67d866, 3 curve(s), switch 1
HDR tone curve: extended 5e67d866, emitting
HDR chain draw: ps 5e67d866 -> 0x... 2560x1472 ..., float target yes
HDR upscaler input: upscaler 5, proxies 0, view R16G16B16A16Sfloat over scene ..., 2560x1440 -> 3840x2160
HDR excess: 3840x2160 RGBA16F from the reconstruction's result (gamma 2.2 applied)
HDR excess: the upscaler's image          (the present found one)
HDR present: upscaled 1, frame 3840x2160 format R16G16B16A16Sfloat, ...
```

The `HDR upscaler input` line is the new one for the transport question: if `proxies 0` and the view
is RGBA16F, the reconstruction is handed the chain's own float values. If `proxies 1` shows an 8-bit
view over a float scene, that view is a clamp in itself (the `SceneTargets::Read` path still asks
for the guest's format) and is the next thing to fix.

`HDR excess: ... (gamma 2.2 applied)` is DLSS (its result is linear light); `(gamma 2.2 kept)` is
TAA, FSR 1 or FSR 4, which are handed the game's frame and hand it back in the same domain.

## What only a run can settle

1. whether DLSS, TAA, FSR 4 and FSR 1 preserve values above 1 (their shaders are not bbport's);
2. whether the presented image is output-sized (`frame 3840x2160`) — the code now blits the display
   image at its own size, and `display.valid == false` is the one path that still falls back to the
   guest's frame;
3. the panel numbers, which are the acceptance table.

## Deliberately not changed

- `Run()` (the native-AA path, taken when the game renders at output size *without* the UI
  composition) still writes the upscaled result back into the scene colour and does not produce an
  excess image. The scaled path, which is what DLSS-Q and TAA at 3840x2160 use, is the one fixed;
  `Run()` is left for when a run shows it is the path in use.
- The `SceneTargets::Read` format (`ci.format = color.info.pixel_format`) is logged, not changed:
  with `BB_LIVE_HYBRID` off, `ProxiesOn()` is false for a scaled session, so the float view is the
  one in use — and changing a view format without knowing the proxy's own format risks a mismatch.
- `strength` and `enabled` in the tone curve's push data stay 1: their switch is the compile-time
  `BB_HDR_SCENE_CURVE`, and a runtime one needs a setting (P5).
