"""The page registry is spread across three modules; nothing made them agree.

A tab is declared in four places:

    build_dashboard.PAGE_MODULES   the modules actually built
    chrome.NAV_ITEMS               the links rendered into every page's nav
    chrome.PAGE_TITLES             the <title> per view
    paths.PAGE_FILENAMES           view_id -> output filename

Drift between them fails in ways nothing catches at build time. A view in
NAV_ITEMS with no module in PAGE_MODULES renders a nav link on every page
pointing at an .html file the build never writes -- a 404 reachable from the
header of a shipped dashboard, with a green build and a green suite. The
reverse (a module whose view_id is in no NAV_ITEMS entry) writes a page no
link reaches.

These guards exist because the MC tab trim (7 tabs -> 2) edited all four by
hand. See docs/PROJECT_BRIEF.md §3 "Tabs".
"""
from common.paths import PAGE_FILENAMES
from common.chrome import NAV_ITEMS, PAGE_TITLES, STUB_VIEWS

import build_dashboard


NAV_IDS = [view_id for view_id, _key, _label in NAV_ITEMS]


def test_nav_ids_are_unique():
    assert len(NAV_IDS) == len(set(NAV_IDS)), f"duplicate view_id in NAV_ITEMS: {NAV_IDS}"


def test_every_nav_item_has_a_filename_and_a_title():
    missing_file = [v for v in NAV_IDS if v not in PAGE_FILENAMES]
    missing_title = [v for v in NAV_IDS if v not in PAGE_TITLES]
    assert not missing_file, f"NAV_ITEMS views absent from PAGE_FILENAMES: {missing_file}"
    assert not missing_title, f"NAV_ITEMS views absent from PAGE_TITLES: {missing_title}"


def test_no_orphan_filenames_or_titles():
    """A leftover entry is harmless on its own but is how a dropped tab creeps
    back: the next person adds it to NAV_ITEMS, sees the filename already
    there, and ships a link to a page nothing builds."""
    nav = set(NAV_IDS)
    assert set(PAGE_FILENAMES) == nav, (
        f"PAGE_FILENAMES has {sorted(set(PAGE_FILENAMES) - nav)} not in NAV_ITEMS"
    )
    assert set(PAGE_TITLES) == nav, (
        f"PAGE_TITLES has {sorted(set(PAGE_TITLES) - nav)} not in NAV_ITEMS"
    )


def test_every_nav_link_is_actually_built():
    """The dangling-link guard: every tab in the header must correspond to a
    module in PAGE_MODULES, or the link 404s from every page that renders it."""
    built = {m.VIEW_ID for m in build_dashboard.PAGE_MODULES}
    assert built == set(NAV_IDS), (
        f"nav links with no module: {sorted(set(NAV_IDS) - built)}; "
        f"modules with no nav link: {sorted(built - set(NAV_IDS))}"
    )


def test_output_filenames_are_distinct():
    names = list(PAGE_FILENAMES.values())
    assert len(names) == len(set(names)), f"two views write the same file: {names}"


def test_stub_views_are_real_views():
    assert STUB_VIEWS <= set(NAV_IDS), (
        f"STUB_VIEWS names views that are not tabs: {sorted(STUB_VIEWS - set(NAV_IDS))}"
    )
