"""Regression tests for F021 — the xlsx export must never produce silent corruption.

`xml_escape` rewrites & < > only, so a control character such as \\x00 in a report
field passed straight through into the worksheet. Reproduced before the fix: the
sheet XML failed `ET.fromstring` with "not well-formed (invalid token)", yet
`_build_xlsx` still returned a structurally valid 1794-byte ZIP. Excel reports
"unreadable content", and the frontend's PK-magic-bytes sanity check cannot detect
it because the ZIP container is fine — so the failure was completely silent.

Reports reach the exporter from MongoDB, including any stored before the /report
validator was tightened, so sanitising at the export boundary is still required.
"""

import io
import xml.etree.ElementTree as ET
import zipfile

import pytest


def sheet_of(app_module, documents):
    body, count = app_module._build_xlsx(documents)
    with zipfile.ZipFile(io.BytesIO(body)) as package:
        return package.read("xl/worksheets/sheet1.xml").decode("utf-8"), count


# --- the corruption vector ----------------------------------------------------

@pytest.mark.parametrize("bad", ["\x00", "\x01", "\x08", "\x0b", "\x0c", "\x1f", "\x00\x08", "a\x00b"])
def test_control_characters_do_not_corrupt_the_worksheet(app_module, bad):
    sheet, _ = sheet_of(app_module, [{"_id": "1", "area": bad, "lat": 13.0, "lng": 80.2}])
    ET.fromstring(sheet)   # raises if the XML is malformed — the original failure


def test_the_whole_package_still_parses_with_hostile_content(app_module):
    documents = [
        {"_id": "1", "area": "bad\x00char", "cause": "x\x08y", "lat": 13.0},
        {"_id": "2", "area": "A & B <tag>", "vehicle": 'quote"inside', "lat": 12.9},
        {"_id": "3", "area": "emoji 🚦 and ünïcodé", "lat": 13.1},
    ]
    body, count = app_module._build_xlsx(documents)

    assert count == 3
    with zipfile.ZipFile(io.BytesIO(body)) as package:
        assert package.testzip() is None
        for name in package.namelist():
            if name.endswith(".xml") or name.endswith(".rels"):
                ET.fromstring(package.read(name))   # every part must be well-formed


def test_tab_newline_and_return_are_preserved(app_module):
    """These three ARE legal in XML 1.0 and carry meaning in a cell."""
    sheet, _ = sheet_of(app_module, [{"_id": "1", "area": "line1\nline2\tcol\r", "lat": 13.0}])
    ET.fromstring(sheet)
    assert "line1" in sheet and "line2" in sheet


def test_non_ascii_survives_the_export(app_module):
    sheet, _ = sheet_of(app_module, [{"_id": "1", "area": "Teynampet – ünïcodé 🚦", "lat": 13.0}])
    ET.fromstring(sheet)
    assert "ünïcodé" in sheet


def test_xml_metacharacters_are_still_escaped_not_stripped(app_module):
    sheet, _ = sheet_of(app_module, [{"_id": "1", "area": "A & B <tag>", "lat": 13.0}])
    assert "A &amp; B &lt;tag&gt;" in sheet
    assert "<tag>" not in sheet
    ET.fromstring(sheet)


# --- column references --------------------------------------------------------

def test_column_ref_matches_spreadsheet_lettering(app_module):
    assert app_module._column_ref(0) == "A"
    assert app_module._column_ref(8) == "I"      # the 9th and last column today
    assert app_module._column_ref(25) == "Z"
    assert app_module._column_ref(26) == "AA"    # `chr(65 + i)` emitted "[" here
    assert app_module._column_ref(51) == "AZ"
    assert app_module._column_ref(52) == "BA"
    assert app_module._column_ref(701) == "ZZ"
    assert app_module._column_ref(702) == "AAA"


def test_every_current_column_gets_a_letter_reference(app_module):
    sheet, _ = sheet_of(app_module, [{"_id": "1", "lat": 13.0}])
    for index in range(len(app_module.EXPORT_COLUMNS)):
        assert f'r="{app_module._column_ref(index)}1"' in sheet


def test_the_export_never_emits_a_non_letter_column_reference(app_module):
    """Guards the `chr(65 + i)` landmine if EXPORT_COLUMNS ever grows past Z."""
    import re

    sheet, _ = sheet_of(app_module, [{"_id": "1", "lat": 13.0}])
    for ref in re.findall(r'<c r="([^"]+)"', sheet):
        assert re.fullmatch(r"[A-Z]+\d+", ref), f"malformed cell reference {ref!r}"


# --- end to end ---------------------------------------------------------------

def test_export_endpoint_survives_a_hostile_stored_report(db_client, app_module, valid_report):
    """A report stored BEFORE validation was tightened must not break the export."""
    collection = app_module._client[app_module.DB_NAME][app_module.COLLECTION_NAME]
    collection.insert_one({**valid_report, "area": "legacy\x00report", "cause": "x\x0by"})

    response = db_client.get("/export/xlsx")

    assert response.status_code == 200
    assert response.headers["x-report-count"] == "1"
    with zipfile.ZipFile(io.BytesIO(response.content)) as package:
        ET.fromstring(package.read("xl/worksheets/sheet1.xml"))


def test_empty_collection_still_produces_a_readable_workbook(app_module):
    body, count = app_module._build_xlsx([])
    assert count == 0
    with zipfile.ZipFile(io.BytesIO(body)) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
    assert sheet is not None
