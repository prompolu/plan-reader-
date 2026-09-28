"""Private object storage.

Uploaded drawings may be confidential: files are stored under random keys
outside any web root and are only ever served through the API after an
authorization check and signature verification.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Protocol

from .config import Settings, get_settings

KEY_RE = re.compile(r"^[A-Za-z0-9/_.-]{1,400}$")


def _check_key(key: str) -> str:
    if not KEY_RE.match(key) or ".." in key or key.startswith("/"):
        raise ValueError("invalid storage key")
    return key


class Storage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...

    def delete_prefix(self, prefix: str) -> None: ...

    def exists(self, key: str) -> bool: ...

    def presigned_url(self, key: str, ttl: int, content_type: str | None = None, filename: str | None = None) -> str | None:
        """A time-limited direct URL (object stores only); None for local storage."""


class LocalStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass

    def _path(self, key: str) -> Path:
        p = (self.root / _check_key(key)).resolve()
        if self.root not in p.parents:
            raise ValueError("invalid storage key")
        return p

    def put(self, key: str, data: bytes, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        # atomic write
        fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".tmp-")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        try:
            self._path(key).unlink()
        except FileNotFoundError:
            pass

    def delete_prefix(self, prefix: str) -> None:
        import shutil

        base = self._path(prefix.rstrip("/"))
        if base.is_dir():
            shutil.rmtree(base, ignore_errors=True)

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def presigned_url(self, key: str, ttl: int, content_type: str | None = None, filename: str | None = None) -> str | None:
        return None


class S3Storage:
    """S3-compatible private bucket (AWS S3, MinIO, R2 ...)."""

    def __init__(self, s: Settings):
        import boto3

        self.bucket = s.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint_url,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=_check_key(key), Body=data, ContentType=content_type, ServerSideEncryption="AES256")

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=_check_key(key))["Body"].read()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=_check_key(key))

    def delete_prefix(self, prefix: str) -> None:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=_check_key(prefix)):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if objs:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs})

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=_check_key(key))
            return True
        except Exception:
            return False

    def presigned_url(self, key: str, ttl: int, content_type: str | None = None, filename: str | None = None) -> str | None:
        params = {"Bucket": self.bucket, "Key": _check_key(key)}
        if content_type:
            params["ResponseContentType"] = content_type
        if filename:
            params["ResponseContentDisposition"] = f'inline; filename="{filename}"'
        return self.client.generate_presigned_url("get_object", Params=params, ExpiresIn=ttl)


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        s = get_settings()
        _storage = S3Storage(s) if s.storage_backend == "s3" else LocalStorage(s.storage_dir)
    return _storage


def reset_storage() -> None:
    global _storage
    _storage = None
