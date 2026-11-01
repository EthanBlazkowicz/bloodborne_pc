// SPDX-FileCopyrightText: Copyright 2026 bbport contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// bbport: what the upscaler is given and what the game's chain gets back (render/upscale/
// vk_temporal_upscaler.cpp). The 16-bit chain's frame is gamma 2.2 encoded, above SDR white,
// in BT.709 primaries with channels below 0 for colours outside BT.709. Temporal reconstruction
// works in linear light on non-negative values: it gets the frame decoded to linear BT.2020,
// where those colours are positive (anything still negative there, outside BT.2020, is dropped,
// as the final pass drops it), and the game's later UI/display passes get their own encoding and
// primaries back. Neither direction is a tone mapper: a colour inside BT.2020 round trips
// unchanged but for rounding. Ported from ports/lantern/nativeplus-engine.patch
// (host_shaders/hdr/upscale_transfer.glsl), the implementation that carries the peak through
// the upscaler.

#ifndef BBPORT_HDR_UPSCALE_TRANSFER_GLSL
#define BBPORT_HDR_UPSCALE_TRANSFER_GLSL

// Linear BT.709 -> BT.2020 primaries (columns), and its exact inverse (computed from these
// values, so a round trip changes nothing but rounding).
const mat3 BB_BT709_TO_BT2020 = mat3(
    0.6274040, 0.0690970, 0.0163916,
    0.3292820, 0.9195400, 0.0880132,
    0.0433136, 0.0113612, 0.8955950);
const mat3 BB_BT2020_TO_BT709 = mat3(
    1.6604902958, -0.1245499701, -0.0181511189,
    -0.5876391058, 1.1328999220, -0.1005787239,
    -0.0728515982, -0.0083479642, 1.1187298782);

// The FP16 limit: extreme inputs stay representable instead of writing infinity into the
// temporal history. The chain's normal output (peak / paper white) is far below it.
const float BB_FP16_MAX = 65504.0;

vec3 bb_signed_pow(vec3 v, float power) {
    return sign(v) * pow(abs(v), vec3(power));
}

vec3 bb_upscale_decode(vec3 encoded) {
    vec3 linear = clamp(bb_signed_pow(encoded, 2.2), vec3(-BB_FP16_MAX), vec3(BB_FP16_MAX));
    return clamp(BB_BT709_TO_BT2020 * linear, vec3(0.0), vec3(BB_FP16_MAX));
}

vec3 bb_upscale_encode(vec3 linear) {
    vec3 bt709 = BB_BT2020_TO_BT709 * clamp(linear, vec3(0.0), vec3(BB_FP16_MAX));
    return bb_signed_pow(clamp(bt709, vec3(-BB_FP16_MAX), vec3(BB_FP16_MAX)), 1.0 / 2.2);
}

#endif // BBPORT_HDR_UPSCALE_TRANSFER_GLSL
