"""Drain a stopped collector without losing expired or rejected batches."""

import shutil
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path


def metrics(state):
    result = {}
    for path in state.rglob("queue.sqlite3"):
        if path.is_symlink():
            raise RuntimeError("Queue database must be a regular file")
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as database:
            pending = database.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
            lost = database.execute("SELECT COALESCE(SUM(points),0) FROM losses").fetchone()[0]
            tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            participants = {}
            for table in ("participant_queue", "participant_rejections"):
                participants[table] = database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] if table in tables else 0
            unacknowledged = database.execute(
                "SELECT COUNT(*) FROM participant_facts WHERE acknowledged=0"
            ).fetchone()[0] if "participant_facts" in tables else 0
        result[str(path.relative_to(state))] = (
            pending, lost, participants["participant_queue"], participants["participant_rejections"], unacknowledged)
    if not result:
        raise RuntimeError("No existing collector queue found")
    return result


def drain(state, invoke):
    if not state.is_dir() or state.is_symlink():
        raise RuntimeError("Collector state must be a regular directory")
    backup = state.with_name(state.name + ".move-backup")
    if backup.exists():
        raise RuntimeError("An unfinished queue backup requires reconciliation")
    if any(path.is_symlink() for path in state.rglob("*")):
        raise RuntimeError("Collector state must not contain symlinks")
    before = metrics(state)
    shutil.copytree(state, backup)
    try:
        invoke()
        after = metrics(state)
        if set(before) != set(after) or any(
            values[0] != 0 or values[1] != before[name][1] or any(values[2:])
            for name, values in after.items()
        ):
            raise RuntimeError("Queue delivery was incomplete")
    except BaseException:
        # Both services are stopped. Restore the exact old-project identity and queue;
        # acknowledged batches may replay, but an unacknowledged batch is never lost.
        shutil.rmtree(state)
        backup.rename(state)
        raise RuntimeError("Queue preserved; resolve delivery failure or explicitly discard") from None
    shutil.rmtree(backup)


def invoke():
    result = subprocess.run(["/usr/local/bin/recount-collector", "--drain"],
                            capture_output=True, timeout=130, check=False)
    if result.returncode != 0:
        raise RuntimeError("Collector drain failed")


if __name__ == "__main__":
    drain(Path("/var/lib/recount-collector"), invoke)
