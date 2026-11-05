# Prompt for the next session — continue the HDR "native+" work

Paste the section from "PROMPT" to the end into a new session.

---

## PROMPT

Continue the HDR "native+" work in `D:\Code\bloodborne_pc` (bbport: a PS4 emulator with a shadPS4-derived
renderer, running Bloodborne; C++23, Vulkan 1.3, CMake + Ninja, Windows).

**Goal.** RenoDX-style HDR: the SDR look preserved below paper white, above-white taken from the
game's own composite tone curve extended above a knee (not estimated); every control live; output
HDR10 PQ BT.2020 (`A2B10G10R10`, `HDR10_ST2084`) with correct `vkSetHdrMetadataEXT` every swapchain and
on settings change; the UI composed at UI white and never expanded.

**Branch.** `hdr-nativeplus-port`, pushed, HEAD `710d1b0`.

### Build

```bash
export MSYSTEM=CLANG64
export PATH="/c/Users/wow99/scoop/shims:$PATH"
cmake -S gpu -B out/win-native -G Ninja -DBB_NET=OFF -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      -DCMAKE_CXX_FLAGS=-ID:/Code/bloodborne_pc/out/deps/xbyak
ninja -C out/win-native bb-probe hdr-output-test settings-test
```

Tests: `out/win-native/hdr-output-test.exe` (20 GPU cases, ~1 s), `settings-test.exe`.
Both must pass before anything is committed.

### Run

- Harness install: `E:\Bloodborne-bbport-nativeplus-hdr` — the stock 0.7 release with **our**
  `bin\bb-probe.exe` swapped in. `scripts\mirror-hdr-harness.ps1 [-Overlay]` does that and regenerates
  the ini.
- Game dump: `E:\CUSA03173` (sibling of the harness folder).
- `bbport.ini`: `hdr=1`, `hdr_mode=native+`, `hdr_peak=790`, `hdr_paper_white=203`, `hdr_knee=0.6`,
  `upscaler=dlss`, `preset=1`, `output_res=3840x2160`.
- **The tone-curve extension needs `BB_HDR_SCENE_CURVE=1`** (read once at translation time). Launch via
  `Start-Process` from a shell that has it set so the child inherits.
- Drive a run with `scripts\verify-hdr-fast.ps1 -DataRoot 'E:\Bloodborne-bbport-nativeplus-hdr'
  [-SettleSeconds N] [-ShotCount N] [-KeepOpen] [-Overlay]`. The whole run has a **60 s budget**; a
  missing level marker throws instead of screenshotting whatever is on screen.
- Logs: `E:\Bloodborne-bbport-nativeplus-hdr\logs\<stamp>.log`.

### Verified — do not re-litigate without new evidence

- **Peak 791.0144 nits** on bright frames (reference: 791.01); dark frames **202.9121** (paper white
  203). Reproducible.
- Ordinary surfaces match a known-good reference build to ~0.001 per channel (carpet, lantern, wall,
  window), measured from 32-bit float captures.
- Black level and range are identical to the reference (2.6 % true black in both; no full-white
  pixels in either).
- The pipeline is colour-faithful between its stages: GPU readbacks of the chain input, the
  reconstruction output and the excess agree to four decimals.
- The composite's proxy is RGBA16F, its view is 16F, and the excess view handed to the present is the
  handle the encode wrote.
- The transfer decode/encode pair is algebraically the identity for in-gamut colour.
- The tone-curve extension and the excess merge are both **exonerated** by experiment (the same wrong
  colours with each disabled).

### Open defects, in the order to attack them

1. **The loading screen fills only the top-left quarter; the title screen is correct.**
   Root cause found: the rewritten display copy's scale is **inverted and hard-coded** —
   `gpu/render/shaders/hdr/bb_display_copy.frag:55-56` computes `1920.0 / w` where it must be
   `w / target`, and the display image is created at the **output** size
   (`gpu/upscale/upscaler_redirect.cpp:317-318`), so its fragments run to 3840 while the scale assumes
   1080. Fix design: pass the target size into the shader (there is a free push-constant field after
   `ToneCurveIndex = 176`; `bb_hdr` sits at offset 128 and is written per draw in
   `rasterizer.cpp:782-829`), compute `scale = source / target`, and keep the display image
   output-sized. Do all three parts: doing only one reproduces one of two wrong pictures (a quarter
   screen, or a 2× zoom/doubled image) — both were tried and reverted.
   The user believes this is also related to defect 2.

2. **The blue channel is wrong at emissive pixels.** Candle flames carry blue 0.249 where the
   reference has 0.068; the moon/window reads `(0.993, 0.998, 0.108)` where the reference reads
   `(0.716, 0.788, 0.931)`. Red and green are identity on 94.5 % of the frame; blue correlates with
   the reference only 0.318 and has 2.8× its spread, i.e. blue is effectively *a different image*.
   Survives with the merge off and with the extension off.
   Leading hypothesis: `bb_display_copy.frag:38-43` applies the game's per-channel brightness table to
   the chain's values, and its above-white branch is a per-channel multiply (`table(1.0) * v`) — a
   per-channel gain that only bites above white, which is exactly the symptom pattern.

3. **Intermittent GPU device lost at the first scene draw** (~1 run in 3). Requires the chain images
   to reproduce; SDR and `BB_HDR_CHAIN=0` both survive. Breadcrumbs point between the camera-motion
   compute pass and the next indexed draw.

### Instruments — which to trust

- **Trust `ReadbackSwapchain`** (commit `710d1b0`): copies texels straight out of the
  `A2B10G10R10` swapchain after the HDR output pass and prints PQ codes. Gated on `BB_HDR_DUMP`, fires
  only on frames that carry an excess (i.e. gameplay). This is what the panel is handed, with no
  capture chain in between. `ReadbackPixels` is trustworthy too, but **RGBA16F only**.
- **Distrust** `DumpImages` / `DumpPresentedFloat16`: they write 8-bit clamped data under `rgba16f`
  names, zero subnormals, ignore sign in `.max`, and defer writes so the last frames never appear.
  `FLAG_CHAIN_VIEW` was deleted in `f3e5b8a` — it clamped above-white and returned before the PQ
  encode, and with `BB_HDR_DUMP` set it *was* the live picture.
- Harness screenshots land on loading/early frames; for gameplay use the user's own captures
  (HDRFrame `.jxr`, 32-bit float, in `C:\Users\wow99\Pictures\HDRFrame\Desktop\2026-11\`) or the
  swapchain readback.

### Working rules

- Any code change goes to an adversarial reviewer, and back to them after the fix, until the defect is
  no longer verifiable by reading the code or compiling.
- The test harness (game runs) only on the user's explicit say-so.
- Keep commits small and in P-order; push to `hdr-nativeplus-port`.
- Reviewer/teammate targets from the last session: `conversion-analyst`, `chain-analyst`,
  `measurement-analyst` (spawn fresh ones if they are gone).

### Start here

1. Fix the display-copy scale (defect 1), all three parts, and verify the loading screen fills the
   frame while the title screen stays correct.
2. Re-measure defect 2 with `ReadbackSwapchain` at the moon and candle pixels and compare against the
   reference capture — the numbers at those two pixels decide whether the brightness table's
   above-white branch is the mechanism.
3. Only then continue with the colour fix and the device lost.
