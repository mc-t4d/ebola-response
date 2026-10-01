"""Bridge from the portal profile's cartography block into the JS payload.

SPDX-License-Identifier: MIT
Copyright (c) 2026 Prosper Global

Upstream paints every choropleth by interpolating a continuous stop array over
a log domain (PALETTES / lerpColor in Scripts/assets/engine.js). Our house
style is a *classed* ramp: five explicit breaks, 1–4 / 5–10 / 11–21 / 22–44 /
45+, so the web map and the daily static map show the same five colours. Those
are different colour models, not different palettes, so the layer definitions
carry an extra `classes` field and engine.js switches on its presence.

Everything here reads config/portal.*.yaml. No break, colour or layer id is
written in Python, so the cartography stays a config change (see the
"Externalize all portal config" rule in docs/ENGINEERING_RULES.md).
"""

from __future__ import annotations

from typing import Any, Iterable

from common.portal_config import load_portal_config

__all__ = [
    "case_class_spec",
    "apply_case_classes",
    "flowminder_enabled",
    "drop_gated_layers",
]

#: Layer keys whose `enabled: false` in the portal profile should also switch
#: off the matching UI in the dashboard.
_FLOWMINDER_LAYER = "flowminder_short_trips"


def _carto(cfg=None) -> dict[str, Any]:
    cfg = cfg or load_portal_config()
    return cfg.cartography.get("case_choropleth", {}) or {}


def case_class_spec(cfg=None) -> dict[str, Any] | None:
    """The classed-ramp spec to attach to a layer, or None if not configured.

    Shape consumed by engine.js:
        {"classes": [{"min", "max", "color", "label_en", "label_fr"}, ...],
         "null_color", "zero_color", "fill_opacity", "outline", "outline_width"}

    `max: None` marks the open-ended top class. Labels are carried per language
    rather than pre-resolved, so the live language switch needs no rebuild.
    """
    carto = _carto(cfg)
    breaks = carto.get("breaks") or []
    if not breaks:
        return None

    classes = []
    for b in breaks:
        classes.append({
            "min": b["min"],
            "max": b.get("max"),
            "color": b["color"],
            "label_en": b.get("label_en", ""),
            "label_fr": b.get("label_fr", b.get("label_en", "")),
        })

    return {
        "classes": classes,
        # "No cases yet" is NULL, not 0, and must not read as a confirmed zero.
        "null_color": carto.get("null_color"),
        "null_label_en": carto.get("null_label_en", ""),
        "null_label_fr": carto.get("null_label_fr", carto.get("null_label_en", "")),
        "zero_color": carto.get("zero_color"),
        # True while the source fills unreached zones with 0 instead of null;
        # a 0 is then drawn as "no cases reported" rather than as an observed
        # zero. See the comment on this key in config/portal.agol.yaml.
        "zero_is_no_data": bool(carto.get("zero_is_no_data", False)),
        "fill_opacity": carto.get("opacity", 0.85),
        "outline": carto.get("outline"),
        "outline_width": carto.get("outline_width", 0.5),
    }


def apply_case_classes(layers: Iterable[dict], cfg=None) -> int:
    """Attach the classed ramp to every layer the profile names.

    Mutates the layer dicts in place (they are on their way into the payload)
    and returns how many were changed, so the build can report it and a
    mis-typed layer id shows up as a count of 0 rather than as a map that
    quietly kept the INSP ramp.
    """
    cfg = cfg or load_portal_config()
    spec = case_class_spec(cfg)
    if not spec:
        return 0

    targets = set(_carto(cfg).get("apply_to_layers") or [])
    if not targets:
        return 0

    changed = 0
    for layer in layers:
        if layer.get("id") in targets:
            layer.update(spec)
            changed += 1
    return changed


def drop_gated_layers(layers: list[dict], cfg=None) -> list[dict]:
    """Remove dropdown layers belonging to a portal layer that is disabled.

    `layer_config.yaml`'s `exclude` only reaches auto-discovered GeoJSON
    layers; EXTRA_LAYER_DEFS in data_sources.py bypass it entirely. So a
    disabled portal layer names its dashboard layer ids explicitly
    (`dashboard_layer_ids`) and they are filtered here, which keeps one config
    flag in charge of the whole feature rather than three scattered edits.

    Returns a new list; the caller rebinds.
    """
    cfg = cfg or load_portal_config()
    gated: set[str] = set()
    for key, ref in cfg.layers.items():
        if ref.enabled:
            continue
        for lid in ref.options.get("dashboard_layer_ids") or []:
            gated.add(str(lid))
    if not gated:
        return list(layers)
    return [L for L in layers if L.get("id") not in gated]


def flowminder_enabled(cfg=None) -> bool:
    """Whether Flowminder UI should be exposed at all.

    False for the first build, per docs/PROJECT_BRIEF.md §3: the weekly
    short-trips series is cohort-aggregate — Bunia/Mongbwalu/Rwampara pooled,
    every origin row identical — so per-zone in/out-flow arrows imply pairwise
    movement the data cannot support. True pairwise OD exists only at province
    resolution for a single March snapshot.

    This is the toggle hook the brief asks to keep: flip
    `layers.flowminder_short_trips.enabled` in the portal profile and the
    controls come back, with no code change.
    """
    cfg = cfg or load_portal_config()
    try:
        return cfg.layer(_FLOWMINDER_LAYER).enabled
    except Exception:
        # A profile that does not define the layer at all is treated as "off",
        # matching the first-build default rather than failing the build.
        return False
