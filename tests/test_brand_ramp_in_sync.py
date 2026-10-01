"""The case-count ramp is declared twice, and both copies are load-bearing.

    Data/Branding/dashboard-theme.css   --brand-case-1..5
        styles legend swatches and anything rendered by a static CSS rule

    config/portal.agol.yaml             cartography.case_choropleth.breaks
        read by the Leaflet style function that fills the choropleth

Drift between them is invisible in review and nearly invisible on screen: the
map paints one set of colours and its own legend paints another, off by a step.
Anyone comparing the web map against the daily static map would see a mismatch
and have no reason to suspect the legend rather than the data.

The same reasoning upstream applies to its --zone-* tokens and engine.js
themeVar() fallbacks (see tests/test_zone_state_styling.py). This is that guard
for the brand ramp.

Values come from the T4D Cartographic Style-Guide (Final, 05/25) and the
published static map's legend; the endpoints are exact brand colours.
"""
import re
from pathlib import Path

from common.portal_config import load_portal_config

REPO = Path(__file__).resolve().parents[1]
THEME = REPO / "Data" / "Branding" / "dashboard-theme.css"

# Style-guide brand colours the ramp is pinned to at each end.
BRAND_YELLOW = "#FFD200"
BRAND_MC_RED = "#C8102E"

N_CLASSES = 5


def _css_tokens():
    text = THEME.read_text(encoding="utf-8")
    # Strip comments first: a commented-out declaration must not read as live.
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return {
        m.group(1): m.group(2).upper()
        for m in re.finditer(r"(--brand-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;", text)
    }


def _css_ramp():
    tokens = _css_tokens()
    return [tokens.get(f"--brand-case-{i}") for i in range(1, N_CLASSES + 1)]


def _yaml_breaks():
    return load_portal_config().class_breaks


def test_css_declares_the_whole_ramp():
    missing = [
        f"--brand-case-{i}"
        for i, v in enumerate(_css_ramp(), start=1)
        if v is None
    ]
    assert not missing, f"theme CSS is missing ramp tokens: {missing}"


def test_yaml_has_the_same_number_of_classes():
    assert len(_yaml_breaks()) == N_CLASSES


def test_ramp_colours_agree():
    css = _css_ramp()
    yaml_colours = [b["color"].upper() for b in _yaml_breaks()]
    assert css == yaml_colours, (
        "the choropleth and its legend would disagree:\n"
        f"  theme CSS : {css}\n"
        f"  portal YAML: {yaml_colours}"
    )


def test_ramp_endpoints_are_brand_colours():
    """The ramp interpolates between two exact style-guide colours. Losing
    either end is how a 'small' colour tweak walks the map off brand."""
    css = _css_ramp()
    assert css[0] == BRAND_YELLOW, f"ramp should start at brand YELLOW, got {css[0]}"
    assert css[-1] == BRAND_MC_RED, f"ramp should end at MC RED, got {css[-1]}"


def test_breaks_are_contiguous_and_open_ended():
    """1–4 / 5–10 / 11–21 / 22–44 / 45+. A gap between classes silently drops
    zones from the map; the top class must stay open so a new maximum cannot
    fall outside every break."""
    breaks = _yaml_breaks()
    for lower, upper in zip(breaks, breaks[1:]):
        assert lower["max"] is not None, "only the last class may be open-ended"
        assert upper["min"] == lower["max"] + 1, (
            f"gap or overlap between classes: {lower} -> {upper}"
        )
    assert breaks[-1]["max"] is None, "the top class must be open-ended"


def test_null_is_distinct_from_zero():
    """'No cases yet' is NULL and must never render as a confirmed zero."""
    carto = load_portal_config().cartography["case_choropleth"]
    assert carto["null_color"].upper() != carto["zero_color"].upper()
    ramp = [c.upper() for c in _css_ramp()]
    assert carto["null_color"].upper() not in ramp, (
        "the NULL fill is one of the ramp colours; an unaffected zone would "
        "read as a case count"
    )
