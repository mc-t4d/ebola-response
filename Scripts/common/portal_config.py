"""Portal configuration — the single AGOL <-> ArcGIS Enterprise seam.

SPDX-License-Identifier: MIT
Copyright (c) 2026 INRB / INOHA / INSP  (upstream: INRB-UMIE/BDBV2026-Epidemic_Dashboard)
Copyright (c) 2026 Mercy Corps         (modifications and new work)

Every portal URL, item id, service URL, field name, class break, corridor
style and time-slider setting lives in ``config/portal.<profile>.yaml``.
Nothing in ``Scripts/`` or ``Scripts/assets/`` may hard-code any of them, so
moving from ArcGIS Online to ArcGIS Enterprise is a profile swap:

    MC_PORTAL_PROFILE=enterprise python Scripts/build_dashboard.py

Typical use in a page module::

    from common.portal_config import load_portal_config

    cfg = load_portal_config()
    cfg.require()                       # raise if anything is still TODO
    js = json.dumps(cfg.to_js_dict())   # bake into the self-contained HTML

The JS side (``Scripts/assets/engine.js`` + the MC style spec) reads that one
object and feeds it to esri-leaflet ``featureLayer({url, where, ...})``.

Environment overrides (all optional):
    MC_PORTAL_PROFILE   profile name, default "agol"
    MC_PORTAL_CONFIG    explicit path to a profile YAML, wins over the profile
    MC_PORTAL_URL       override portal.url
    MC_PORTAL_AUTH_MODE override auth.mode
    MC_LAYER_<KEY>_URL  override one layer's service_url, e.g. MC_LAYER_CASES_URL
"""

from __future__ import annotations

import copy
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import yaml

__all__ = [
    "PortalConfigError",
    "LayerRef",
    "PortalConfig",
    "load_portal_config",
    "config_dir",
]

# Scripts/common/portal_config.py -> Scripts/common -> Scripts -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO_ROOT / "config"
DEFAULT_PROFILE = "agol"

#: A value that has not been filled in yet. Cheap to spot, loud when validated.
TODO_PREFIX = "TODO"

#: Guard against an ``extends:`` cycle between profiles.
MAX_EXTENDS_DEPTH = 8


class PortalConfigError(RuntimeError):
    """Raised when the portal profile is missing, malformed, or incomplete."""


def config_dir() -> Path:
    """Directory holding the profile YAMLs."""
    return CONFIG_DIR


def is_placeholder(value: Any) -> bool:
    """True when *value* is unset or still a ``TODO:`` marker."""
    if value is None:
        return True
    if isinstance(value, str):
        stripped = value.strip()
        return not stripped or stripped.upper().startswith(TODO_PREFIX)
    return False


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge *override* into a copy of *base* (override wins)."""
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _read_yaml(path: Path) -> dict:
    if not path.is_file():
        raise PortalConfigError(f"Portal profile not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise PortalConfigError(f"Portal profile is not a mapping: {path}")
    return data


def _resolve_profile(raw: dict, path: Path, depth: int = 0) -> dict:
    """Apply ``extends:`` so a child profile only restates what differs."""
    parent_name = raw.get("extends")
    if not parent_name:
        return raw
    if depth >= MAX_EXTENDS_DEPTH:
        raise PortalConfigError(
            f"'extends' chain too deep (possible cycle) starting at {path}"
        )
    parent_path = (path.parent / str(parent_name)).resolve()
    parent = _resolve_profile(_read_yaml(parent_path), parent_path, depth + 1)
    child = {k: v for k, v in raw.items() if k != "extends"}
    return _deep_merge(parent, child)


@dataclass(frozen=True)
class LayerRef:
    """One published feature layer, addressed by role rather than by id."""

    key: str
    title: str = ""
    item_id: str | None = None
    service_url: str | None = None
    layer_id: int = 0
    geometry_type: str = "polygon"
    enabled: bool = True
    fields: dict[str, str] = field(default_factory=dict)
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def url(self) -> str | None:
        """Full esri-leaflet layer URL, i.e. ``<FeatureServer>/<layer_id>``."""
        if is_placeholder(self.service_url):
            return None
        return f"{str(self.service_url).rstrip('/')}/{self.layer_id}"

    @property
    def configured(self) -> bool:
        return self.url is not None

    def field_for(self, role: str) -> str:
        """Actual column name for a logical *role* (``name``, ``date``, ...)."""
        try:
            return self.fields[role]
        except KeyError:
            raise PortalConfigError(
                f"Layer '{self.key}' has no field mapped for role '{role}'. "
                f"Add it under layers.{self.key}.fields in the portal profile."
            ) from None

    def to_js_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "title": self.title,
            "url": self.url,
            "itemId": self.item_id if not is_placeholder(self.item_id) else None,
            "geometryType": self.geometry_type,
            "enabled": self.enabled,
            "fields": dict(self.fields),
            **{k: v for k, v in self.options.items()},
        }


@dataclass(frozen=True)
class PortalConfig:
    """Parsed portal profile. Treat as read-only."""

    profile: str
    label: str
    source_path: Path
    portal: dict[str, Any]
    auth: dict[str, Any]
    layers: dict[str, LayerRef]
    cartography: dict[str, Any]
    time: dict[str, Any]
    map: dict[str, Any]

    # -- access ------------------------------------------------------------

    def layer(self, key: str) -> LayerRef:
        try:
            return self.layers[key]
        except KeyError:
            known = ", ".join(sorted(self.layers)) or "(none)"
            raise PortalConfigError(
                f"Unknown layer '{key}'. Defined layers: {known}"
            ) from None

    def enabled_layers(self) -> Iterator[LayerRef]:
        """Layers that are switched on, in the configured draw order."""
        order = list(self.map.get("layer_order") or [])
        ordered = [k for k in order if k in self.layers]
        ordered += [k for k in self.layers if k not in ordered]
        for key in ordered:
            ref = self.layers[key]
            if ref.enabled:
                yield ref

    @property
    def sharing_rest(self) -> str | None:
        """REST root, derived from ``portal.url`` when not stated outright."""
        explicit = self.portal.get("sharing_rest")
        if not is_placeholder(explicit):
            return str(explicit).rstrip("/")
        base = self.portal.get("url")
        if is_placeholder(base):
            return None
        return f"{str(base).rstrip('/')}/sharing/rest"

    @property
    def class_breaks(self) -> list[dict[str, Any]]:
        return list(self.cartography.get("case_choropleth", {}).get("breaks", []))

    def break_colors(self) -> list[str]:
        return [str(b["color"]) for b in self.class_breaks]

    # -- secrets -----------------------------------------------------------

    def api_key(self) -> str | None:
        """Read the API key from the env var named in the profile.

        The key itself is never stored in the repo. Returns None when the
        variable is unset, which is the normal case for anonymous layers.
        """
        env_name = self.auth.get("api_key_env")
        return os.environ.get(env_name) if env_name else None

    # -- validation --------------------------------------------------------

    def problems(self, *, include_disabled: bool = False) -> list[str]:
        """Human-readable list of everything still unconfigured."""
        issues: list[str] = []

        if is_placeholder(self.portal.get("url")):
            issues.append("portal.url is not set")

        mode = self.auth.get("mode")
        if mode not in {"anonymous", "api_key", "named_user", "web_tier"}:
            issues.append(f"auth.mode '{mode}' is not a recognised mode")
        if mode == "api_key" and not self.api_key():
            issues.append(
                f"auth.mode is 'api_key' but ${self.auth.get('api_key_env')} is unset"
            )

        for key, ref in self.layers.items():
            if not ref.enabled and not include_disabled:
                continue
            if not ref.configured:
                issues.append(f"layers.{key}.service_url is not set")

        if not self.class_breaks:
            issues.append("cartography.case_choropleth.breaks is empty")

        time_layer = self.time.get("layer")
        if time_layer and time_layer not in self.layers:
            issues.append(f"time.layer '{time_layer}' is not a defined layer")

        return issues

    def require(self, *, include_disabled: bool = False) -> None:
        """Raise unless the profile is complete enough to build against."""
        issues = self.problems(include_disabled=include_disabled)
        if issues:
            bullets = "\n  - ".join(issues)
            raise PortalConfigError(
                f"Portal profile '{self.profile}' ({self.source_path.name}) "
                f"is incomplete:\n  - {bullets}"
            )

    # -- export ------------------------------------------------------------

    def to_js_dict(self) -> dict[str, Any]:
        """JSON-serialisable config to bake into the generated HTML.

        Secrets are omitted unless ``auth.embed_key_in_build`` is explicitly
        true — these pages are static files, so anything embedded is public.
        """
        auth: dict[str, Any] = {"mode": self.auth.get("mode", "anonymous")}
        if self.auth.get("embed_key_in_build"):
            key = self.api_key()
            if key:
                auth["apiKey"] = key

        return {
            "profile": self.profile,
            "label": self.label,
            "portal": {
                "url": None if is_placeholder(self.portal.get("url")) else self.portal["url"],
                "sharingRest": self.sharing_rest,
            },
            "auth": auth,
            "layers": {k: v.to_js_dict() for k, v in self.layers.items()},
            "layerOrder": [ref.key for ref in self.enabled_layers()],
            "cartography": copy.deepcopy(self.cartography),
            "time": copy.deepcopy(self.time),
            "map": copy.deepcopy(self.map),
        }


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

_RESERVED_LAYER_KEYS = {
    "title", "item_id", "service_url", "layer_id", "geometry_type",
    "enabled", "fields",
}


def _build_layers(raw: dict) -> dict[str, LayerRef]:
    layers: dict[str, LayerRef] = {}
    for key, spec in (raw.get("layers") or {}).items():
        if not isinstance(spec, dict):
            raise PortalConfigError(f"layers.{key} must be a mapping")
        url_override = os.environ.get(f"MC_LAYER_{key.upper()}_URL")
        layers[key] = LayerRef(
            key=key,
            title=spec.get("title", key),
            item_id=spec.get("item_id"),
            service_url=url_override or spec.get("service_url"),
            layer_id=int(spec.get("layer_id", 0)),
            geometry_type=spec.get("geometry_type", "polygon"),
            enabled=bool(spec.get("enabled", True)),
            fields=dict(spec.get("fields") or {}),
            # Anything else (simplify_factor, precision, ...) rides along to JS.
            options={k: v for k, v in spec.items() if k not in _RESERVED_LAYER_KEYS},
        )
    return layers


def load_portal_config(
    profile: str | None = None,
    *,
    path: str | Path | None = None,
) -> PortalConfig:
    """Load a portal profile.

    Resolution order: explicit *path* > ``$MC_PORTAL_CONFIG`` > *profile*
    argument > ``$MC_PORTAL_PROFILE`` > ``"agol"``.
    """
    if path is None:
        path = os.environ.get("MC_PORTAL_CONFIG") or None

    if path is not None:
        profile_path = Path(path).expanduser().resolve()
    else:
        name = profile or os.environ.get("MC_PORTAL_PROFILE") or DEFAULT_PROFILE
        profile_path = (CONFIG_DIR / f"portal.{name}.yaml").resolve()

    raw = _resolve_profile(_read_yaml(profile_path), profile_path)

    portal = dict(raw.get("portal") or {})
    if os.environ.get("MC_PORTAL_URL"):
        portal["url"] = os.environ["MC_PORTAL_URL"]

    auth = dict(raw.get("auth") or {})
    if os.environ.get("MC_PORTAL_AUTH_MODE"):
        auth["mode"] = os.environ["MC_PORTAL_AUTH_MODE"]

    return PortalConfig(
        profile=str(raw.get("profile") or profile_path.stem),
        label=str(raw.get("label") or ""),
        source_path=profile_path,
        portal=portal,
        auth=auth,
        layers=_build_layers(raw),
        cartography=dict(raw.get("cartography") or {}),
        time=dict(raw.get("time") or {}),
        map=dict(raw.get("map") or {}),
    )


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    import json
    import sys

    cfg = load_portal_config(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"profile : {cfg.profile} ({cfg.source_path})")
    print(f"portal  : {cfg.portal.get('url')}")
    print(f"layers  : {', '.join(sorted(cfg.layers))}")
    print(f"breaks  : {' '.join(cfg.break_colors())}")
    issues = cfg.problems()
    print(f"problems: {len(issues)}")
    for issue in issues:
        print(f"  - {issue}")
    print(json.dumps(cfg.to_js_dict(), indent=2)[:400] + " ...")
