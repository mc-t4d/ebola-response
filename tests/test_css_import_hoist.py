"""The @import hoist must move the WHOLE at-rule, not part of one.

build_dashboard concatenates the brand theme after dashboard.css, and CSS
requires @import to precede every other rule, so _write_shared_assets() lifts
the theme's @import lines to the top of the combined sheet.

The failure this guards is brutal and completely silent. A Google Fonts URL
carries semicolons inside it:

    @import url("...css2?family=League+Spartan:wght@300;400;500&...");

so a pattern ending at the FIRST semicolon truncates the at-rule mid-URL and
leaves an unterminated string at the top of the stylesheet. The browser then
discards the ENTIRE sheet: the request is 200 OK, the <link> reports a sheet
object, the console logs nothing, and document.styleSheets[n].cssRules.length
is 0. The page renders as unstyled HTML with no error anywhere to explain it.

That shipped once. These tests are why it cannot ship twice.
"""
import re

import build_dashboard as bd


GOOGLE_FONTS = (
    '@import url("https://fonts.googleapis.com/css2'
    "?family=League+Spartan:wght@300;400;500;600;700"
    "&family=Merriweather:ital,wght@0,300;0,400;0,700;1,400"
    '&display=swap");'
)


def _balanced(s: str) -> bool:
    return s.count('"') % 2 == 0 and s.count("(") == s.count(")")


def test_pattern_captures_a_whole_import_containing_semicolons():
    found = bd._CSS_IMPORT.findall(GOOGLE_FONTS + "\n")
    assert len(found) == 1, f"expected one match, got {found}"
    assert found[0].strip() == GOOGLE_FONTS, (
        "the at-rule was truncated -- almost certainly matched to the first "
        f"semicolon inside the URL:\n  {found[0].strip()}"
    )


def test_captured_import_is_syntactically_closed():
    """The specific damage: an odd number of quotes at the top of a sheet."""
    captured = bd._CSS_IMPORT.findall(GOOGLE_FONTS + "\n")[0]
    assert _balanced(captured), f"unbalanced quotes/parens in {captured!r}"
    assert captured.rstrip().endswith(";")


def test_nothing_of_the_import_is_left_in_the_body():
    """A truncating pattern removes its own partial match and leaves the TAIL
    of the URL behind, e.g. `400;500;600;700&...&display=swap");`. That tail
    contains neither "@import" nor the host, so checking for those two is not
    enough -- look for any surviving crumb of the at-rule."""
    theme = f"{GOOGLE_FONTS}\n\n:root {{ --x: 1; }}\n"
    body = bd._CSS_IMPORT.sub("", theme)
    assert "@import" not in body
    for crumb in ("fonts.googleapis.com", "display=swap", "&family=", 'url("'):
        assert crumb not in body, (
            f"fragment {crumb!r} stayed behind in the sheet body:\n{body[:160]!r}"
        )
    assert _balanced(body), "the hoist left unbalanced quotes/parens in the body"
    assert "--x: 1;" in body, "the hoist removed more than the at-rule"


def test_real_theme_file_yields_one_closed_import():
    """Guards the shipped file, not just a synthetic string."""
    theme = bd.load_theme_css()
    imports = bd._CSS_IMPORT.findall(theme)
    assert len(imports) == 1, f"expected exactly one @import, got {len(imports)}"
    assert _balanced(imports[0]), f"unbalanced: {imports[0]!r}"


def test_assembled_sheet_starts_with_a_closed_import_then_real_rules():
    """End to end: the first line of what the browser gets must parse."""
    theme = bd.load_theme_css()
    base = ":root { --from-base: 1; }\n"
    imports = "".join(
        m if m.endswith("\n") else m + "\n" for m in bd._CSS_IMPORT.findall(theme)
    )
    combined = f"{imports}{base}\n{bd._CSS_IMPORT.sub('', theme)}"

    first = combined.splitlines()[0]
    assert first.startswith("@import"), f"sheet does not open with @import: {first!r}"
    assert _balanced(first), f"sheet opens with an unterminated at-rule: {first!r}"
    # Everything after the leading @import block must carry no further @import,
    # which would be invalid where it sits.
    rest = combined[len(imports):]
    assert not re.search(r"^[ \t]*@import", rest, flags=re.MULTILINE)
    assert "--from-base: 1;" in rest
