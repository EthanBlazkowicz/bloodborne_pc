# Review protocol for HDR changes (ground rule, 2026-11-05)

Every code change on `hdr-nativeplus-port` goes to an adversarial reviewer before it is believed,
and goes back to that reviewer after the fix — repeatedly, until nothing is left that a reader or a
compiler could still disagree with. A reviewer's "fixed" is not the end of the loop; the loop ends
when the change is either verified or has nothing left to verify.

## Who reviews what

| Area | Reviewer brief |
|---|---|
| Vulkan transport, resource lifetime, layouts, synchronization, the upscaler/presenter seam | Vulkan transport review |
| Tone-curve extension math, the present's encode (2.2, PQ, BT.2020), grading, excess reconstruction | Tone math review |
| Requirements: controls live, metadata, UI contract, environment surface, cache separation, retirement | Conformance review |

A change that spans areas goes to every reviewer whose area it touches, in one dispatch, each with
the hunks that belong to it.

## What "verified" means here

- **Reading**: no remaining path where the reviewer can construct a failure from the code.
- **Compiling**: the tree builds and every shader compiles (`ninja -C out/win-native bb-probe`,
  which runs glslang over `gpu/render/shaders/**`). A green build is evidence for the compiler,
  never for the logic.
- Anything that needs a run is recorded as such and stays open — it is not signed off by silence.

## State of the loop (HEAD `25c6806`)

| Round | Changes | Outcome |
|---|---|---|
| 1 | `866ba4c`, `368ffdb` | five defects found: delta double-count, peak domain, single-channel colour lift, 709 metadata on a 2020 container, dead probe; plus the `hdr_excess_fresh` lifecycle blocker |
| 2 | `4dd8537`, `992bb26`, `c50d03d`, `72ad28b` | re-review: all round-1 findings fixed; the branch turned out not to compile at all (a removed function and an older dump API in `presenter.cpp`) |
| 3 | `25c6806` | dispatched — per-pipeline delta gate, letterbox guard, `ui_white` from the setting, knee range, excess flag reset, dump schedule |

## Building (the compiler half of the loop)

MSYS2 CLANG64 (`C:\Users\wow99\scoop\apps\msys2\current`), `MSYSTEM=CLANG64`, git on `PATH`:

```
cmake -S gpu -B out/win-native -G Ninja -DBB_NET=OFF -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      -DCMAKE_CXX_FLAGS=-ID:/Code/bloodborne_pc/out/deps/xbyak
ninja -C out/win-native bb-probe
```

`out/deps/xbyak` is xbyak cloned from GitHub: the tree includes `<xbyak/xbyak.h>` in two files,
nothing in CMake provides it, and MSYS2 does not package it. `gpu/third_party/{fsr-vulkan,imgui}`
and `third_party/LibAtrac9` are submodules and start empty.
