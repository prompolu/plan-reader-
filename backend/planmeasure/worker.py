"""Background worker entry point: ``python -m planmeasure.worker``."""

from __future__ import annotations

import logging
import signal
import threading

from .config import get_settings
from .jobs import worker_loop


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    get_settings().validate_for_production()
    stop = threading.Event()

    def _stop(*_):
        logging.info("worker stopping after current job")
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    worker_loop(stop)


if __name__ == "__main__":
    main()
