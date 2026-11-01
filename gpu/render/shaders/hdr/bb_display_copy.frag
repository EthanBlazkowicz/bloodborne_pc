// SPDX-FileCopyrightText: Copyright 2026 bbport
// SPDX-License-Identifier: GPL-2.0-or-later
//
// bbport HDR, mode 5 (the 16-bit chain, docs/HDR.md): replaces the game's display copy
// (38d65b32), which copies its finished image into the display buffer through its brightness
// curve (a 1D table per channel). The table covers 0..1; above the game's white the value goes on
// as the table's value at white times the input (still in the chain's gamma encoding: the final
// pass decodes it, post_process.frag native16_nits). The names are the recompiled shader's: vk_hdr_channel.cpp
// copies its bindings and locations onto these.

#version 450
#extension GL_EXT_samplerless_texture_functions : require

// The recompiler's push constants (shader_recompiler/resource.h, PushData) at the C++ struct's
// offsets (checked in vk_rasterizer.cpp); bb_hdr is bbport's, set per draw (vk_rasterizer.cpp).
layout(push_constant, std430) uniform AuxData {
    layout(offset = 0) float xoffset;
    layout(offset = 4) float yoffset;
    layout(offset = 8) float xscale;
    layout(offset = 12) float yscale;
    layout(offset = 80) uvec4 buf_offsets0;
    layout(offset = 96) uvec4 buf_offsets1;
    layout(offset = 112) uvec2 buf_offsets2;
    layout(offset = 120) uint motion_param;
    layout(offset = 124) uint scene_size;
    layout(offset = 128) uvec4 bb_hdr;
} push_data;

layout(set = 0, binding = 0) uniform texture2D fs_img0;
// The brightness table (one row per channel): a 1D array image. Lantern's recompiler keeps 1D
// image types (shadPS4 0.20.1, bbport's, binds it as a 2D array view instead): a 2D array
// declaration read 0 here and the whole frame was black.
layout(set = 0, binding = 1) uniform texture1DArray fs_img1;
layout(set = 0, binding = 2) uniform sampler fs_samp0;

layout(location = 0) out vec4 frag_color0;

float table(float v, float row) {
    if (v <= 1.0) {
        return texture(sampler1DArray(fs_img1, fs_samp0), vec2(v, row)).x;
    }
    return texture(sampler1DArray(fs_img1, fs_samp0), vec2(1.0, row)).x * v;
}

// Below 0 (PsychoV30 with a BT.2020 target: a channel of a color outside BT.709), the curve
// continued point-symmetric about its value at 0: the table alone read its value at 0 there and
// the channel lost its sign.
float brightness(float v, float row) {
    return v >= 0.0 ? table(v, row) : 2.0 * table(0.0, row) - table(-v, row);
}

void main() {
    uint w = push_data.scene_size & 65535u;
    uint h = push_data.scene_size >> 16u;
    vec2 scale = vec2(1920.0 / float(w == 0u ? 1920u : w), 1080.0 / float(h == 0u ? 1080u : h));
    vec4 v = texelFetch(fs_img0, ivec2(floor(gl_FragCoord.xy * scale)), 0);
    // Chain probe 11 (test): what this pass receives, in grey (0.5 = the game's white, brighter
    // above it: 0.75 at 2x, 1.0 at 4x and beyond). A logarithmic scale, so it survives the
    // captures and cannot be confused with the scene's own colours.
    if (push_data.bb_hdr.z == 11u) {
        const float m = max(max(v.x, v.y), v.z);
        frag_color0 = vec4(vec3(0.5 + 0.25 * log2(max(m, 1e-4))), v.w);
        return;
    }
    // Chain probe 10 (test): what this pass receives, false-coloured (black below 0.5, blue to
    // 1, green to 2, yellow to 4, red above). If the highlights are not green/yellow/red here,
    // the chain clamped them before the display copy.
    if (push_data.bb_hdr.z == 10u) {
        const float m = max(max(v.x, v.y), v.z);
        vec3 fc = m < 0.5 ? vec3(0.0)
                  : m < 1.0 ? vec3(0.0, 0.0, 1.0)
                  : m < 2.0 ? vec3(0.0, 1.0, 0.0)
                  : m < 4.0 ? vec3(1.0, 1.0, 0.0)
                            : vec3(1.0, 0.0, 0.0);
        frag_color0 = vec4(fc, v.w);
        return;
    }
    // The chain's order is set by the colour table (bb_color_grading.frag); the display buffer
    // takes it as it comes. Converting here would also convert the UI, which the game composites
    // through this same shader.
    // Chain probe 18 (test): this pass's input alpha as grey — the channel the excess above the
    // game's white travels in. Black where there is nothing to add, white where the chain's frame
    // still holds the game's own alpha.
    if (push_data.bb_hdr.z == 18u) {
        frag_color0 = vec4(vec3(clamp(v.w, 0.0, 1.0)), 1.0);
        return;
    }
    vec3 o = vec3(brightness(v.x, 0.0), brightness(v.y, 1.0), brightness(v.z, 2.0));
    // Native+: what the composite made above the game's white comes in the frame's alpha (its
    // target is the guest's 8-bit image, so RGB clamps there). Added here, in this pass's own
    // output — the float display image the encode carries correctly.
    o += vec3(clamp(v.w, 0.0, 1.0));
    // Chain probe 17 (test): bands of known above-white (2x and 4x) written as this pass's own
    // output, past the brightness table. The encoder's readout then says whether the table's
    // above-white path is what compresses them, or the upscaler after it.
    if (push_data.bb_hdr.z == 17u) {
        const float px = gl_FragCoord.x;
        const float py = gl_FragCoord.y;
        if (py > 700.0 && py < 1300.0 && px < 1800.0) {
            frag_color0 = vec4(vec3(px < 900.0 ? 2.0 : 4.0), 1.0);
            return;
        }
    }

    // Chain probe 14 (test): what this pass receives, by how far above the game's white it is —
    // the composite's target as the display buffer takes it. Grey: nothing above white
    // (magenta past 1.02x, blue past 2x, red past 4x).
    if (push_data.bb_hdr.z == 14u) {
        const float m14 = max(max(v.x, v.y), v.z);
        vec3 shown = vec3(dot(v.xyz, vec3(0.2126, 0.7152, 0.0722)) * 0.5);
        if (m14 > 4.0) {
            shown = vec3(1.0, 0.0, 0.0);
        } else if (m14 > 2.0) {
            shown = vec3(0.0, 0.0, 1.0);
        } else if (m14 > 1.02) {
            shown = vec3(1.0, 0.0, 1.0);
        }
        frag_color0 = vec4(shown, v.w);
        return;
    }
    // Chain probe 12 (test): this pass's OUTPUT, same log scale (0.5 = white, 0.75 = 2x, 1.0 = 4x).
    // Grey here and colour at probe 11's input = the write's target clamps.
    if (push_data.bb_hdr.z == 12u) {
        const float mo = max(max(o.x, o.y), o.z);
        frag_color0 = vec4(vec3(0.5 + 0.25 * log2(max(mo, 1e-4))), v.w);
        return;
    }
    frag_color0 = vec4(o, v.w);
    // Chain probe 5 (test): the colour through without the brightness table. A correct scene here
    // and a tinted one otherwise = the table's rows (layers) are not the channel order we read.
    if (push_data.bb_hdr.z == 5u) {
        frag_color0 = vec4(v.x, v.y, v.z, v.w);
    }
    // Chain probe (in-game menu, test; bb_hdr.z): 2 magenta where the finished image is above
    // the game's white.
    if (push_data.bb_hdr.z == 2u && max(max(v.x, v.y), v.z) > 1.001) {
        frag_color0 = vec4(1.0, 0.0, 1.0, v.w);
    }
}
