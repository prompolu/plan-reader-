import os
import tempfile

import pytest

# configure a separate database and storage before the app is imported
os.environ.setdefault("PM_DATABASE_URL", "postgresql+psycopg://planmeasure:planmeasure@localhost:5432/planmeasure_test")
os.environ["PM_ENV"] = "test"
os.environ["PM_STORAGE_DIR"] = tempfile.mkdtemp(prefix="pm-test-storage-")
os.environ["PM_RUN_WORKER_IN_PROCESS"] = "false"
os.environ["PM_RATE_LIMIT_API"] = "100000/minute"


def _db_available() -> bool:
    try:
        from sqlalchemy import create_engine, text

        e = create_engine(os.environ["PM_DATABASE_URL"])
        with e.connect() as c:
            c.execute(text("SELECT 1"))
        e.dispose()
        return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def app():
    if not _db_available():
        pytest.skip("PostgreSQL test database not available")
    from planmeasure import models  # noqa: F401
    from planmeasure.db import Base, get_engine
    from planmeasure.main import create_app

    eng = get_engine()
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    return create_app()


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    from planmeasure.security import rate_limiter

    rate_limiter.reset()
    with TestClient(app) as c:
        yield c


def signup(client, email, password="Str0ng-Password", name="Tester"):
    r = client.post("/api/auth/register", json={"email": email, "password": password, "name": name})
    if r.status_code == 409:
        r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    client.headers["x-csrf-token"] = r.json()["csrf_token"]
    return r.json()


def run_jobs():
    from planmeasure.jobs import worker_loop

    return worker_loop(once=True)
