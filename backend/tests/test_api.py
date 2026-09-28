"""API tests: authentication, authorization, uploads, processing, review, export."""

import io
import uuid

import pymupdf
import pytest

from conftest import run_jobs, signup
from planmeasure.demo.sets import demo_set


@pytest.fixture(scope="module")
def demo_pdf():
    pdf, _ = demo_set()
    return pdf


def _upload(client, pid, name, data, ctype="application/pdf"):
    return client.post(f"/api/projects/{pid}/documents", files=[("files", (name, io.BytesIO(data), ctype))])


# -- auth ------------------------------------------------------------------------------


def test_register_login_logout(client):
    email = f"a{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/auth/register", json={"email": email, "password": "weak"})
    assert r.status_code == 422
    signup(client, email)
    assert client.get("/api/auth/me").json()["user"]["email"] == email
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    r = client.post("/api/auth/login", json={"email": email, "password": "Wrong-passw0rd"})
    assert r.status_code == 401


def test_session_cookie_is_httponly(client):
    email = f"c{uuid.uuid4().hex[:8]}@example.com"
    r = client.post("/api/auth/register", json={"email": email, "password": "Str0ng-Password"})
    cookie = r.headers.get("set-cookie", "")
    assert "pm_session=" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie


def test_csrf_required_for_mutations(client):
    signup(client, f"csrf{uuid.uuid4().hex[:6]}@example.com")
    token = client.headers.pop("x-csrf-token")
    assert client.post("/api/projects", json={"name": "P"}).status_code == 403
    client.headers["x-csrf-token"] = token
    assert client.post("/api/projects", json={"name": "P"}).status_code == 201


def test_login_rate_limited(client):
    for _ in range(10):
        client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "x"})
    r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "x"})
    assert r.status_code == 429


def test_browser_workspace_without_sign_in(client, app):
    from fastapi.testclient import TestClient

    r = client.post("/api/auth/workspace")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["workspace"] is True
    cookie = r.headers.get("set-cookie", "")
    assert "pm_session=" in cookie and "HttpOnly" in cookie
    client.headers["x-csrf-token"] = body["csrf_token"]
    # the same browser keeps its workspace
    again = client.post("/api/auth/workspace").json()
    assert again["user"]["id"] == body["user"]["id"] and again["csrf_token"] == body["csrf_token"]
    pid = client.post("/api/projects", json={"name": "Mine"}).json()["id"]
    # another browser gets its own, separate workspace
    with TestClient(app) as other:
        o = other.post("/api/auth/workspace").json()
        assert o["user"]["id"] != body["user"]["id"]
        assert other.get(f"/api/projects/{pid}").status_code == 404
        assert all(p["id"] != pid for p in other.get("/api/projects").json())
    # workspaces cannot be entered with a password, nor registered by email
    email = body["user"]["email"]
    assert client.post("/api/auth/login", json={"email": email, "password": "!"}).status_code == 401
    assert client.post("/api/auth/register", json={"email": "x@workspace.local", "password": "Str0ng-Password"}).status_code == 422
    # reopening an existing workspace is not rate limited (every page load does it)
    for _ in range(15):
        assert client.post("/api/auth/workspace").status_code == 200


def test_workspace_session_keeps_its_lifetime_when_sliding(client, app):
    from datetime import datetime, timedelta, timezone

    from planmeasure.db import get_sessionmaker
    from planmeasure.models import UserSession
    from planmeasure.security import token_hash

    client.post("/api/auth/workspace")
    token = client.cookies.get("pm_session")
    with get_sessionmaker()() as db:
        sess = db.query(UserSession).filter_by(token_hash=token_hash(token)).one()
        sess.last_seen_at = sess.last_seen_at - timedelta(minutes=5)
        sess.expires_at = sess.expires_at - timedelta(minutes=5)
        db.commit()
    assert client.get("/api/auth/me").status_code == 200
    with get_sessionmaker()() as db:
        sess = db.query(UserSession).filter_by(token_hash=token_hash(token)).one()
        assert sess.expires_at - datetime.now(timezone.utc) > timedelta(days=300)


def test_security_headers(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]


# -- uploads -----------------------------------------------------------------------------


def test_upload_validation(client, demo_pdf):
    signup(client, f"u{uuid.uuid4().hex[:6]}@example.com")
    pid = client.post("/api/projects", json={"name": "Uploads"}).json()["id"]
    # not a PDF despite the extension
    r = _upload(client, pid, "plans.pdf", b"hello world")
    assert r.status_code == 422
    # extension does not match content
    r = _upload(client, pid, "plans.png", demo_pdf, "image/png")
    assert r.status_code == 422
    # password-protected PDF
    doc = pymupdf.open(stream=demo_pdf, filetype="pdf")
    enc = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    r = _upload(client, pid, "locked.pdf", enc)
    assert r.status_code == 422 and "Password" in r.text
    # path traversal in the filename is neutralised
    r = _upload(client, pid, "../../etc/Residential Plans.pdf", demo_pdf)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["documents"][0]["filename"] == "Residential Plans.pdf"
    assert body["documents"][0]["page_count"] == 10
    assert body["job"]["status"] == "queued"
    # duplicates are refused
    r = _upload(client, pid, "copy.pdf", demo_pdf)
    assert r.status_code == 422


def test_image_upload(client):
    from PIL import Image

    signup(client, f"img{uuid.uuid4().hex[:6]}@example.com")
    pid = client.post("/api/projects", json={"name": "Images"}).json()["id"]
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buf, format="PNG")
    r = _upload(client, pid, "scan.png", buf.getvalue(), "image/png")
    assert r.status_code == 201
    assert r.json()["documents"][0]["content_type"] == "image/png"


# -- authorization --------------------------------------------------------------------------


def test_projects_are_private(client, app, demo_pdf):
    from fastapi.testclient import TestClient

    signup(client, f"owner{uuid.uuid4().hex[:6]}@example.com")
    pid = client.post("/api/projects", json={"name": "Secret"}).json()["id"]
    with TestClient(app) as other:
        signup(other, f"other{uuid.uuid4().hex[:6]}@example.com")
        assert other.get(f"/api/projects/{pid}").status_code == 404
        assert other.get(f"/api/projects/{pid}/openings").status_code == 404
        assert other.patch(f"/api/projects/{pid}", json={"name": "hacked"}).status_code == 404
        assert all(p["id"] != pid for p in other.get("/api/projects").json())


def test_viewer_cannot_edit(client, app):
    from fastapi.testclient import TestClient

    signup(client, f"own{uuid.uuid4().hex[:6]}@example.com")
    pid = client.post("/api/projects", json={"name": "Shared"}).json()["id"]
    viewer_email = f"view{uuid.uuid4().hex[:6]}@example.com"
    with TestClient(app) as viewer:
        signup(viewer, viewer_email)
        assert client.post(f"/api/projects/{pid}/members", json={"email": viewer_email, "role": "viewer"}).status_code == 201
        assert viewer.get(f"/api/projects/{pid}").status_code == 200
        assert viewer.patch(f"/api/projects/{pid}", json={"name": "x"}).status_code == 403
        assert viewer.post(f"/api/projects/{pid}/openings", json={"type": "door"}).status_code == 403


# -- full workflow ----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def processed(app, demo_pdf):
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        signup(c, f"flow{uuid.uuid4().hex[:6]}@example.com", name="Flow Tester")
        pid = c.post("/api/projects", json={"name": "Residential Building"}).json()["id"]
        assert _upload(c, pid, "Residential_Plans.pdf", demo_pdf).status_code == 201
        assert run_jobs() >= 1
        yield c, pid


def test_processing_results(processed):
    c, pid = processed
    job = c.get(f"/api/projects/{pid}/jobs").json()[0]
    assert job["status"] == "succeeded", job
    assert all(s["status"] == "done" for s in job["steps"].values())
    pages = c.get(f"/api/projects/{pid}/pages").json()
    assert [p["page_type"] for p in pages][:4] == ["cover", "site_plan", "notes", "floor_plan"]
    ops = {o["tag"]: o for o in c.get(f"/api/projects/{pid}/openings").json()}
    assert ops["W-02"]["width"]["value"] == 1800 and ops["W-02"]["width"]["original_text"] == "1800"
    assert ops["W-03"]["height"]["status"] == "conflict"
    assert ops["W-07"]["height"] is None
    runs = c.get(f"/api/projects/{pid}/runs").json()
    assert runs[0]["version"] == "1.0.0" and runs[0]["status"] == "succeeded"
    stats = c.get(f"/api/projects/{pid}").json()["stats"]
    assert stats["openings"] == 26 and stats["needs_review"] > 0


def test_signed_urls(processed, app):
    from fastapi.testclient import TestClient

    c, pid = processed
    page = c.get(f"/api/projects/{pid}/pages").json()[3]
    assert c.get(page["image_url"]).status_code == 200
    # tampered signature
    bad = page["image_url"][:-3] + ("AAA" if not page["image_url"].endswith("AAA") else "BBB")
    assert c.get(bad).status_code == 403
    # a valid link without a session (or for a non-member) is refused
    with TestClient(app) as anon:
        assert anon.get(page["image_url"]).status_code == 401
        signup(anon, f"x{uuid.uuid4().hex[:6]}@example.com")
        assert anon.get(page["image_url"]).status_code == 404
    # region rendering needs the page token
    r = c.get(f"/api/projects/{pid}/pages/{page['id']}/region", params={"x": 100, "y": 100, "w": 200, "h": 100, "scale": 6, "t": page["region_token"]})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    other = c.get(f"/api/projects/{pid}/pages").json()[4]
    r = c.get(f"/api/projects/{pid}/pages/{page['id']}/region", params={"x": 1, "y": 1, "w": 10, "h": 10, "scale": 2, "t": other["region_token"]})
    assert r.status_code == 403


def test_edit_verify_audit(processed):
    c, pid = processed
    w3 = next(o for o in c.get(f"/api/projects/{pid}/openings").json() if o["tag"] == "W-03")
    r = c.post(f"/api/projects/{pid}/openings/{w3['id']}/resolve-conflict", json={"field": "height", "candidate_index": 0})
    assert r.status_code == 200
    o = r.json()
    assert o["height"]["source"] == "user" and o["height"]["value"] in (1200, 1500)
    r = c.patch(f"/api/projects/{pid}/openings/{w3['id']}", json={"changes": {"height": {"text": "1600"}}, "version": o["version"]})
    assert r.status_code == 200
    o = r.json()
    assert o["height"]["value"] == 1600 and "height" in o["edited_fields"]
    assert o["ai_original"]["height"]["status"] == "conflict"  # original AI result preserved
    # stale version is rejected
    r = c.patch(f"/api/projects/{pid}/openings/{w3['id']}", json={"changes": {"notes": "x"}, "version": 1})
    assert r.status_code == 409
    r = c.post(f"/api/projects/{pid}/openings/{w3['id']}/verify", json={"verified": True})
    assert r.json()["status"] == "verified" and r.json()["verification"]["verified_by_user"]
    msgs = [a["message"] for a in c.get(f"/api/projects/{pid}/openings/{w3['id']}/audit").json()]
    assert any(m.startswith("AI extracted") for m in msgs)
    assert any("1600" in m for m in msgs)
    assert msgs[-1] == "User verified opening"
    # invalid edits
    assert c.patch(f"/api/projects/{pid}/openings/{w3['id']}", json={"changes": {"width": {"text": "abc"}}}).status_code == 422
    assert c.patch(f"/api/projects/{pid}/openings/{w3['id']}", json={"changes": {"secret": 1}}).status_code == 422


def test_manual_opening_is_user_sourced(processed):
    c, pid = processed
    r = c.post(f"/api/projects/{pid}/openings", json={"type": "door", "tag": "D-99", "width": {"value": 900, "unit": "mm"}, "height": {"text": "2100"}, "quantity": 2, "page_index": 3})
    assert r.status_code == 201, r.text
    o = r.json()
    assert o["source"] == "user" and o["width"]["source"] == "user" and o["quantity"] == 2
    assert c.delete(f"/api/projects/{pid}/openings/{o['id']}").status_code == 204
    assert all(x["id"] != o["id"] for x in c.get(f"/api/projects/{pid}/openings").json())


def test_reprocess_never_overwrites_user_edits(processed):
    from sqlalchemy import select

    from planmeasure.db import get_sessionmaker
    from planmeasure.models import Opening

    c, pid = processed
    ops = {o["tag"]: o for o in c.get(f"/api/projects/{pid}/openings").json()}
    w1 = ops["W-01"]
    c.patch(f"/api/projects/{pid}/openings/{w1['id']}", json={"changes": {"width": {"value": 1250, "unit": "mm"}}})
    # pretend the previous extraction said something different, so the new run is a change
    with get_sessionmaker()() as db:
        o = db.scalar(select(Opening).where(Opening.id == uuid.UUID(w1["id"])))
        snap = dict(o.ai_snapshot)
        snap["quantity"] = 99
        o.ai_snapshot = snap
        db.commit()
    assert c.post(f"/api/projects/{pid}/process").status_code == 202
    run_jobs()
    ops2 = {o["tag"]: o for o in c.get(f"/api/projects/{pid}/openings").json()}
    assert ops2["W-01"]["width"]["value"] == 1250  # the user's value survives
    assert ops2["W-01"]["pending_ai"] is not None
    assert any(f["code"] == "ai_update_available" for f in ops2["W-01"]["flags"])
    assert ops2["W-03"]["height"]["value"] == 1600 and ops2["W-03"]["status"] == "verified"
    # the user keeps their values explicitly
    r = c.post(f"/api/projects/{pid}/openings/{w1['id']}/ai-update", json={"accept": False})
    assert r.json()["pending_ai"] is None and r.json()["width"]["value"] == 1250
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == 2


def test_review_queue_and_schedule(processed):
    c, pid = processed
    rv = c.get(f"/api/projects/{pid}/review").json()
    codes = {i["code"] for i in rv["items"]}
    assert {"missing_height", "schedule_only", "scale_inferred"} <= codes
    sched = c.get(f"/api/projects/{pid}/schedule", params={"group_by": "type", "unit": "mm"}).json()
    titles = [g["title"] for g in sched["groups"]]
    assert titles[:2] == ["WINDOW SCHEDULE", "DOOR SCHEDULE"]
    by_floor = c.get(f"/api/projects/{pid}/schedule", params={"group_by": "floor"}).json()
    assert {g["title"] for g in by_floor["groups"]} >= {"GROUND FLOOR", "FIRST FLOOR"}
    imp = c.get(f"/api/projects/{pid}/schedule", params={"unit": "ft_in"}).json()
    row = next(r for g in imp["groups"] for r in g["rows"] if r["tag"] == "D-01")
    assert row["width"] == "3'-4 3/16\""


def test_pdf_export_uses_final_values(processed):
    c, pid = processed
    r = c.post(
        f"/api/projects/{pid}/export/pdf",
        json={"kind": "detailed", "page_size": "A3", "orientation": "landscape", "info": {"prepared_by": "QA Reviewer", "project_address": "14 Harbour St"}},
    )
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    doc = pymupdf.open(stream=r.content, filetype="pdf")
    text = "".join(p.get_text() for p in doc)
    assert "1600 mm" in text  # user-edited W-03 height, not the AI value
    assert "QA Reviewer" in text and "WINDOW SCHEDULE" in text
    w, h = doc[0].rect.width, doc[0].rect.height
    assert w > h and abs(w - 1190.55) < 2  # A3 landscape
    r = c.post(f"/api/projects/{pid}/export/pdf", json={"kind": "summary", "page_size": "LETTER"})
    assert r.status_code == 200
    assert c.post(f"/api/projects/{pid}/export/pdf", json={"kind": "x"}).status_code == 422


def test_page_scale_override(processed):
    c, pid = processed
    page = c.get(f"/api/projects/{pid}/pages").json()[3]
    r = c.patch(f"/api/projects/{pid}/pages/{page['id']}", json={"scale_override": "1:50"})
    assert r.status_code == 200 and r.json()["scale_override"]["ratio"] == 50
    assert c.patch(f"/api/projects/{pid}/pages/{page['id']}", json={"scale_override": "big"}).status_code == 422
    r = c.patch(f"/api/projects/{pid}/pages/{page['id']}", json={"scale_override": ""})
    assert r.json()["scale_override"] is None


def test_search(processed):
    c, pid = processed
    res = c.get(f"/api/projects/{pid}/search", params={"q": "W-03"}).json()
    assert {r["sheet"] for r in res} >= {"A-101", "A-202"}
