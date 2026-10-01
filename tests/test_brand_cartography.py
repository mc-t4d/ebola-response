"""Guards for the config -> payload cartography bridge.

common/brand_cartography.py is the only thing that puts house cartography into
the JS payload, and every failure mode here is silent on screen:

  * a mistyped id in `apply_to_layers` leaves the map on the INSP continuous
    log ramp -- still a plausible-looking red choropleth, just not ours and
    not matching the daily static map
  * a dropped `zero_is_no_data` paints 455 of 519 zones white, which reads as
    an observed zero and all but vanishes against the basemap
  * a broken Flowminder gate re-exposes a cohort-aggregate series as a
    per-zone layer, inviting a pairwise reading the data cannot support

See docs/PROJECT_BRIEF.md §3 and the standing rules in
docs/ENGINEERING_RULES.md.
"""
import copy

import pytest

from common import brand_cartography as bc
from common.portal_config import load_portal_config


@pytest.fixture(scope="module")
def cfg():
    return load_portal_config()


def _layers_like_payload():
    """Stand-ins for the real payload layers, including ones that must NOT be
    touched and the Flowminder entries that come from EXTRA_LAYER_DEFS."""
    return [
        {"id": "obs::total", "palette": "reds", "scale": "log"},
        {"id": "obs::confirmed", "palette": "reds", "scale": "log"},
        {"id": "obs::suspected", "palette": "reds", "scale": "log"},
        {"id": "obs::conf_d", "palette": "reds", "scale": "log"},
        {"id": "obs::susp_d", "palette": "reds", "scale": "log"},
        {"id": "worldpop__total", "palette": "viridis", "scale": "log"},
        {"id": "flow::in", "palette": "reds", "scale": "log"},
        {"id": "flow::in_apr", "palette": "reds", "scale": "log"},
    ]


# --- the classed ramp ----------------------------------------------------

def test_spec_carries_five_classes_with_an_open_top(cfg):
    spec = bc.case_class_spec(cfg)
    assert spec is not None
    assert len(spec["classes"]) == 5
    assert spec["classes"][-1]["max"] is None, "top class must be open-ended"
    assert all(c["max"] is not None for c in spec["classes"][:-1])


def test_spec_carries_both_languages(cfg):
    """Labels ship per language so the live language switch needs no rebuild."""
    spec = bc.case_class_spec(cfg)
    for c in spec["classes"]:
        assert c["label_en"], f"class {c} has no English label"
        assert c["label_fr"], f"class {c} has no French label"
    assert spec["null_label_en"] and spec["null_label_fr"]


def test_null_and_zero_stay_distinct_colours(cfg):
    """Even with zero_is_no_data on, the two colours remain separately defined
    so turning the flag off restores a real distinction."""
    spec = bc.case_class_spec(cfg)
    assert spec["null_color"] and spec["zero_color"]
    assert spec["null_color"].upper() != spec["zero_color"].upper()


def test_null_colour_is_not_a_ramp_colour(cfg):
    spec = bc.case_class_spec(cfg)
    ramp = {c["color"].upper() for c in spec["classes"]}
    assert spec["null_color"].upper() not in ramp


def test_apply_hits_every_configured_layer_and_nothing_else(cfg):
    layers = _layers_like_payload()
    n = bc.apply_case_classes(layers, cfg)
    assert n > 0, (
        "no layer matched apply_to_layers -- the map would silently keep the "
        "INSP continuous ramp"
    )
    by_id = {L["id"]: L for L in layers}
    targets = set(cfg.cartography["case_choropleth"]["apply_to_layers"])
    assert n == len(targets)
    for lid in targets:
        assert by_id[lid].get("classes"), f"{lid} did not get classes"
    # An unrelated layer keeps upstream's continuous palette untouched.
    assert "classes" not in by_id["worldpop__total"]
    assert by_id["worldpop__total"]["palette"] == "viridis"


def test_apply_to_layers_ids_exist_in_a_realistic_layer_set(cfg):
    """Catches a typo'd or renamed layer id in the profile."""
    known = {L["id"] for L in _layers_like_payload()}
    targets = set(cfg.cartography["case_choropleth"]["apply_to_layers"])
    assert targets <= known, f"apply_to_layers names unknown ids: {sorted(targets - known)}"


def test_apply_is_idempotent(cfg):
    layers = _layers_like_payload()
    bc.apply_case_classes(layers, cfg)
    once = copy.deepcopy(layers)
    bc.apply_case_classes(layers, cfg)
    assert layers == once


def test_zero_is_no_data_is_carried_through(cfg):
    """While the source fills unreached zones with 0, this must reach the JS or
    455 of 519 zones render white."""
    spec = bc.case_class_spec(cfg)
    assert "zero_is_no_data" in spec
    assert isinstance(spec["zero_is_no_data"], bool)


# --- the Flowminder gate -------------------------------------------------

def test_flowminder_is_off_for_the_first_build(cfg):
    assert bc.flowminder_enabled(cfg) is False, (
        "Flowminder is deferred (PROJECT_BRIEF §3); the series is "
        "cohort-aggregate, so per-zone flows overstate it"
    )


def test_gate_drops_the_flowminder_dropdown_layers(cfg):
    layers = _layers_like_payload()
    kept = {L["id"] for L in bc.drop_gated_layers(layers, cfg)}
    assert "flow::in" not in kept
    assert "flow::in_apr" not in kept
    # and leaves everything else alone
    assert "obs::total" in kept and "worldpop__total" in kept


def test_gate_returns_a_new_list_and_does_not_mutate(cfg):
    layers = _layers_like_payload()
    before = len(layers)
    bc.drop_gated_layers(layers, cfg)
    assert len(layers) == before


def test_gated_ids_are_declared_for_every_disabled_layer(cfg):
    """A disabled portal layer whose dashboard ids are undeclared is the
    failure that left two Flowminder layers in the dropdown: layer_config's
    `exclude` never sees EXTRA_LAYER_DEFS, so the ids must be named here."""
    flow = cfg.layer("flowminder_short_trips")
    assert flow.enabled is False
    ids = flow.options.get("dashboard_layer_ids")
    assert ids, "the disabled Flowminder layer declares no dashboard_layer_ids"
    assert "flow::od" in ids, "the arc catalogue id is missing from the gate"
