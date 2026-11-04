// SPDX-FileCopyrightText: Copyright 2026 bbport contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// bbport: HDR output (render/presenter.cpp RecordHdrPresent). The SDR composite (the frame
// letterboxed into a swapchain-sized sRGB-encoded image; the bars black) and the menu's layer
// (premultiplied alpha, sRGB encoded) become the HDR swapchain's signal: HDR10 (BT.2020
// primaries, PQ) or scRGB (linear BT.709, 1.0 = 80 nits). SDR white is shown at paper_white;
// nothing goes above the peak. Expand (hdr_mode=expand, and native+ frames until the scene
// chain lands): the picture's brightest parts are stretched towards the peak. The game's
// picture is made for SDR displays, which show it with a 2.2 power curve; the piecewise sRGB
// curve lifts Bloodborne's shadows into grey, so 2.2 it is (as RenoDX's Gamma Correction 2.2).
#version 450

layout(location = 0) out vec4 color;

layout(binding = 0) uniform sampler2D game;     // the letterboxed SDR frame, swapchain-sized
layout(binding = 1) uniform sampler2D overlay;  // the menu layer (FLAG_OVERLAY)
layout(binding = 2) uniform sampler2D snapshot; // the frame before the UI (FLAG_UI_MASK)
// Native+: what the chain made above the game's white, per output pixel.
layout(binding = 3) uniform sampler2D excess;

layout(push_constant) uniform Settings {
    float paper_white; // nits of SDR white
    float peak;        // nits the display reaches
    float boost;       // 0: SDR white at paper white .. 1: SDR white at the peak
    uint flags;
    float black_floor; // Native+: the game's darkest greys taken down to true black (of its white)
    float ui_white;    // Native+: the HUD's white as a factor of paper white
    // Native+: the RenoDX-style user grading, neutral at 1 (exposure, contrast, highlights,
    // shadows, saturation).
    float exposure;
    float contrast;
    float highlights;
    float shadows;
    float saturation;
    // The frame the blit put inside the swapchain (the chain's output size): the bars are what is
    // outside it, and this is known even on frames that bind no output-sized image.
    uint content_width;
    uint content_height;
} hdr;

const uint FLAG_SCRGB = 1u;   // scRGB output, else HDR10
const uint FLAG_OVERLAY = 2u; // the menu layer has something drawn
const uint FLAG_DEBUG = 4u;   // BB_HDR_DEBUG: the expansion as a heat map
const uint FLAG_COMPARE = 8u; // the left half as SDR (at paper white), for comparison
// Native+ (render/hdr_channel.cpp): the composite already carries the scene's HDR — the game's
// encoded values extended above its white by the chain's delta. Nothing is expanded; the frame
// decodes with the same 2.2 and is shown as it is (the game's look at paper white where a frame
// has nothing above it).
const uint FLAG_NATIVE16 = 16u;
// Native+: the snapshot's alpha is the HUD's mask (hdr_ui_mask.comp); the HUD is shown at UI
// Brightness (ui_white).
const uint FLAG_UI_MASK = 32u;
// Native+: the frame is linear already (an sRGB view decoded the game's encoding when it was
// sampled): the present must not decode it again.
const uint FLAG_LINEAR_FRAME = 64u;
// Native+: binding 3 holds the excess above the game's white.
const uint FLAG_EXCESS = 512u;
// above the game's white it is. Magenta past 1x, blue past 2x, red past 4x, dim grey below.

// Linear brightness (SDR white = 1) above which the highlights are expanded: high, so large
// bright areas (fog, sky) stay near paper white and only lamps, fire and sparks reach the peak.
const float KNEE = 0.8;

// BT.709 -> BT.2020 primaries (columns).
const mat3 BT709_TO_BT2020 = mat3(
    0.6274, 0.0691, 0.0164,
    0.3293, 0.9195, 0.0880,
    0.0433, 0.0114, 0.8956);

// presenter.cpp's Letterbox, in integers: the rect the blit put the frame in. The fitted size is
// truncated and the offset is an integer halving, so a float window would classify one content
// column as outside the frame and one bar column as inside whenever the fitted size or the bar is
// odd — a dark line on one edge and a bright one on the other.
ivec4 FrameRect(ivec2 chain_size, ivec2 frame_size) {
    const ivec2 c = max(chain_size, ivec2(1));
    const ivec2 f = max(frame_size, ivec2(1));
    const float frame_aspect = float(c.x) / float(c.y);
    const float target_aspect = float(f.x) / float(f.y);
    ivec2 size = f;
    if (frame_aspect > target_aspect) {
        size.y = int(float(f.x) / frame_aspect);
    } else {
        size.x = int(float(f.y) * frame_aspect);
    }
    return ivec4((f - size) / 2, size);
}

bool InsideFrame(ivec2 pixel, ivec2 chain_size, ivec2 frame_size) {
    const ivec4 r = FrameRect(chain_size, frame_size);
    return all(greaterThanEqual(pixel, r.xy)) && all(lessThan(pixel, r.xy + r.zw));
}

// The frame's size inside the swapchain, from the push constants: the same on every native+ frame,
// including the ones that bind no output-sized image (a menu frame, an encode that did not run).
ivec2 FrameSize() {
    return max(ivec2(hdr.content_width, hdr.content_height), ivec2(1));
}

// Where this swapchain pixel comes from in an output-sized chain image, and whether it is inside
// the frame at all. The bars are outside it: the blit left them at the clear, so taking the clamped
// border texel there painted the letterbox with the chain's edge.
bool ChainTexel(ivec2 pixel, ivec2 chain_size, ivec2 frame_size, out ivec2 texel) {
    const ivec4 r = FrameRect(chain_size, frame_size);
    const vec2 c = vec2(max(chain_size, ivec2(1)));
    const vec2 p = (vec2(pixel) - vec2(r.xy)) * c / vec2(max(r.zw, ivec2(1)));
    texel = clamp(ivec2(floor(p)), ivec2(0), chain_size - 1);
    return all(greaterThanEqual(pixel, r.xy)) && all(lessThan(pixel, r.xy + r.zw));
}

// The game's picture is made for SDR displays, which show it with a 2.2 power curve. The
// piecewise sRGB curve (what Windows uses for SDR content in HDR) lifts the shadows: dark
// scenes turn grey and foggy. Bloodborne is mostly shadows, so 2.2 it is.
vec3 SdrToLinear(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(2.2));
}

// SMPTE ST 2084 inverse EOTF; y: luminance / 10000 nits.
vec3 PqEncode(vec3 y) {
    const float m1 = 0.1593017578125;
    const float m2 = 78.84375;
    const float c1 = 0.8359375;
    const float c2 = 18.8515625;
    const float c3 = 18.6875;
    vec3 ym = pow(clamp(y, 0.0, 1.0), vec3(m1));
    return pow((c1 + c2 * ym) / (1.0 + c3 * ym), vec3(m2));
}

// Inverse tone map of the brightest channel (hue and saturation kept): unchanged up to KNEE,
// then a curve with the same slope there that reaches `white` at SDR white.
vec3 ExpandHighlights(vec3 rgb, float white) {
    float m = max(rgb.r, max(rgb.g, rgb.b));
    if (white <= 1.0 || m <= KNEE) {
        return rgb;
    }
    float t = (m - KNEE) / (1.0 - KNEE);
    float expanded = m + (white - 1.0) * t * t;
    return rgb * (expanded / m);
}

// Debug view colours: blue (a little gain) .. cyan .. green .. yellow .. red (the peak).
vec3 Heat(float t) {
    t = clamp(t, 0.0, 1.0);
    return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0),
                      1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0);
}

// The RenoDX-style user grading on the linear scene (native+): exposure, contrast about the
// 0.18 grey, highlights and shadows by luminance, saturation. All neutral at 1.
vec3 Grade(vec3 c) {
    c = max(c, vec3(0.0)) * max(hdr.exposure, 0.0);
    c = (c - 0.18) * max(hdr.contrast, 0.0) + 0.18;
    const float luma = dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
    const float high = smoothstep(0.4, 1.0, luma);
    const float low = 1.0 - smoothstep(0.0, 0.6, luma);
    c *= mix(1.0, hdr.highlights, high);
    c *= mix(1.0, hdr.shadows, low);
    c = mix(vec3(dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722))), c, hdr.saturation);
    return max(c, vec3(0.0));
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 game_srgb = texelFetch(game, pixel, 0).rgb;
    const float peak_white = max(hdr.peak / hdr.paper_white, 1.0);
    // TEMP probe (BB_HDR_DEBUG=1): how far the chain's own frame reaches above white — white:
    // nothing, blue: above white somewhere, red: at least half a stop over.
    if ((hdr.flags & FLAG_DEBUG) != 0u && (hdr.flags & FLAG_EXCESS) != 0u) {
        ivec2 ep;
        vec3 shown = vec3(1.0);
        if (ChainTexel(pixel, FrameSize(), textureSize(game, 0), ep)) {
            const vec3 chain = texelFetch(excess, ep, 0).rgb;
            const float over = max(chain.r, max(chain.g, chain.b)) - 1.0;
            shown = over > 0.5 ? vec3(1.0, 0.0, 0.0)
                               : (over > 0.0 ? vec3(0.0, 0.0, 1.0) : vec3(1.0));
        }
        color = vec4(shown, 1.0);
        return;
    }
    // Native+: the light the chain made above the game's white. The chain's own frame stays
    // RGBA16F through the reconstruction (hdr/hdr_upscale_transfer.comp) and the display pass
    // reads it beside the game's 8-bit image.
    //
    // Per channel, and only where the frame has not got there already: the chain's encoded value
    // where it is higher, the frame's own elsewhere. Taking the height of the brightest channel
    // and scaling every channel by it kept the SDR chroma but not the highlight's: a chain pixel
    // of (2.0, 0.5, 0.3) came out (2.0, 1.0, 0.6), so a saturated lamp core washed towards white.
    // The max is taken in the encoded domain, before the single 2.2 decode below, which is the
    // same operation on every channel and therefore leaves the colour where the chain put it.
    if ((hdr.flags & FLAG_EXCESS) != 0u) {
        ivec2 ep;
        if (ChainTexel(pixel, FrameSize(), textureSize(game, 0), ep)) {
            const vec3 chain = texelFetch(excess, ep, 0).rgb;
            // Not on the HUD's pixels: the chain is the scene before the UI drew, so its value
            // there would replace the HUD with whatever was behind it.
            float ui = 0.0;
            if ((hdr.flags & FLAG_UI_MASK) != 0u) {
                ivec2 mp;
                if (ChainTexel(pixel, FrameSize(), textureSize(game, 0), mp)) {
                    ui = clamp(texelFetch(snapshot, mp, 0).a, 0.0, 1.0);
                }
            }
            if (ui <= 0.0) {
                game_srgb = max(game_srgb, chain);
            }
        }
    }
    const float white = max(mix(1.0, peak_white, clamp(hdr.boost, 0.0, 1.0)), 1.0);
    vec3 sdr_linear = (hdr.flags & FLAG_LINEAR_FRAME) != 0u
                          ? clamp(game_srgb, 0.0, 1.0)
                          : SdrToLinear(game_srgb);
    vec3 linear;
    if ((hdr.flags & FLAG_NATIVE16) != 0u) {
        // The 16-bit chain's frame: the game's encoded picture, above its white included. Decoded
        // here with the same 2.2; nothing expanded (the scene is already as bright as the chain
        // made it).
        linear = sdr_linear;
        // The black floor first (the menu's slider, OLED): the darkest greys down to true black,
        // the rest of the range stretched — 1/(1-f) keeps white at 1 but lifts anything already
        // above it. Clamped after, not before, so the frame still stops at the peak.
        if (hdr.black_floor > 0.0) {
            linear = max(linear - vec3(hdr.black_floor), vec3(0.0)) / (1.0 - hdr.black_floor);
        }
        // The chain shaped its highlights already (the game's curve below the knee, the
        // extension above it, rolled off to the peak), so nothing expands them here and they stop
        // at the peak: the reference's min(sdr_linear * gain, peak_white). Rolling off a second
        // time compressed the top twice (measured 648.90 nits on a configured 790, against the
        // reference's 791.01). Not tied to FLAG_EXCESS: a frame that carries above-white without
        // the excess image (TAA before its transfer, a frame whose encode did not run) would
        // otherwise decode to several times the peak instead of stopping at it.
        linear = min(linear, vec3(peak_white));
        // The user grading (the menu's sliders), before the HUD and the display encode.
        linear = Grade(linear);
        // The HUD (the mask in the snapshot's alpha): shown at UI Brightness — its pixels
        // brightened by the HUD's white over the game's — while the scene stays as it is.
        if ((hdr.flags & FLAG_UI_MASK) != 0u) {
            ivec2 mp;
            if (ChainTexel(pixel, FrameSize(), textureSize(game, 0), mp)) {
                const float ui = clamp(texelFetch(snapshot, mp, 0).a, 0.0, 1.0);
                linear = mix(linear, linear * max(hdr.ui_white, 0.0), ui);
            }
        }
        // The bars are outside the frame and stay black whatever the grade or the black floor does
        // to black (the grade's contrast below 1 lifts 0 by 0.18*(1-k), 18 nits at 0.5). Gated on
        // native+ and not on the excess: a frame without one (a menu, an encode that did not run)
        // would otherwise keep lifted bars and flicker against the gameplay around it. The port's
        // menu is composited further down, so it can still draw over them.
        if ((hdr.flags & FLAG_NATIVE16) != 0u &&
            !InsideFrame(pixel, FrameSize(), textureSize(game, 0))) {
            linear = vec3(0.0);
        }
    } else {
        linear = ExpandHighlights(sdr_linear, white);
    }
    if ((hdr.flags & FLAG_DEBUG) != 0u) {
        // The picture in grey at a third of paper white, the expansion over it from blue (a
        // little) to red (the peak); in native+ the values above the game's white are the
        // chain's, shown from blue up the same way.
        // The frame's own value over the game's white (in native+ sdr_linear is the same frame,
        // so a ratio of the two is always 1 and showed nothing).
        const vec3 base = (hdr.flags & FLAG_NATIVE16) != 0u ? vec3(1.0) : sdr_linear;
        float gain = max(linear.r, max(linear.g, linear.b)) /
                     max(max(base.r, max(base.g, base.b)), 1e-4);
        vec3 shown = vec3(dot(min(linear, vec3(1.0)), vec3(0.2126, 0.7152, 0.0722)) * 0.33);
        if (gain > 1.001) {
            shown = mix(shown, Heat(log2(gain) / max(log2(peak_white), 0.1)), 0.8);
        }
        linear = shown;
    }
    if ((hdr.flags & FLAG_COMPARE) != 0u && (hdr.flags & FLAG_DEBUG) == 0u) {
        // The left half as an SDR display shows the game (at paper white, sRGB's colours), a
        // thin grey line between the two. In native+ the values are clamped back into the
        // game's range: that is what an SDR display would show of it.
        const float middle = 0.5 * float(textureSize(game, 0).x);
        if (gl_FragCoord.x < middle) {
            linear = min(sdr_linear, vec3(1.0));
        }
        if (abs(gl_FragCoord.x - middle) < 1.5) {
            linear = vec3(0.5);
        }
    }
    if ((hdr.flags & FLAG_OVERLAY) != 0u) {
        // The menu over the frame at paper white: the menu is not expanded. In native+ the
        // frame under it is already linear (and possibly above white), so the menu's own sRGB
        // pixels are decoded and blended over it in the light.
        vec4 menu = texelFetch(overlay, pixel, 0);
        if (menu.a > 0.0) {
            vec3 under = (hdr.flags & FLAG_NATIVE16) != 0u ? linear : SdrToLinear(clamp(game_srgb, 0.0, 1.0));
            // The port's own menu is UI, not scene: composed at the HUD's white (UI Brightness),
            // never expanded — 1.0 of it is ui_nits, not paper white. Neutral (ui_white 1) leaves
            // it exactly as before.
            vec3 menu_linear = SdrToLinear(clamp(menu.rgb, 0.0, 1.0)) * max(hdr.ui_white, 0.0);
            linear = mix(under, menu_linear, clamp(menu.a * 4.0, 0.0, 1.0));
        }
    }
    if ((hdr.flags & FLAG_SCRGB) != 0u) {
        color = vec4(linear * (hdr.paper_white / 80.0), 1.0);
    } else {
        vec3 nits = max(BT709_TO_BT2020 * linear, vec3(0.0)) * hdr.paper_white;
        color = vec4(PqEncode(nits / 10000.0), 1.0);
    }
}
