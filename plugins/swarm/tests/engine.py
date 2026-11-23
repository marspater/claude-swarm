"""Runs board.py for the tests: inside this process when it is safe, as a process of its own otherwise.

A test calls the board hundreds of times, and a fresh interpreter for each call was most of the suite's time. The
command's `main(argv)` keeps no state between calls, so one imported copy answers them all. A call from any thread
but the main one stays a real process: those tests are about two commands at once, and output is captured per
process, not per thread. `SWARM_TEST_PROCESSES=1` makes every call a real process, as CI does. verify.py always is
one: measured, its time is git's, and running it here saved nothing.
"""
import contextlib
import io
import os
import subprocess
import sys
import threading
import traceback

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "skills", "swarm", "scripts")
BOARD = os.path.join(SCRIPTS, "board.py")


def board(*args, stdin=None):
    """`board.py ARGS` with STDIN as its input: (exit code, stdout, stderr)."""
    args = [str(arg) for arg in args]
    if os.environ.get("SWARM_TEST_PROCESSES") or threading.current_thread() is not threading.main_thread():
        done = subprocess.run([sys.executable, BOARD, *args], input=stdin, capture_output=True, text=True)
        return done.returncode, done.stdout, done.stderr
    if SCRIPTS not in sys.path:
        sys.path.insert(0, SCRIPTS)
    import board as module  # late: the first call pays for it, a test that never calls the board does not
    # Streams with a byte buffer under them, as a process has: `tail` writes its bytes to sys.stdout.buffer.
    out, err = (io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="", write_through=True) for _ in range(2))
    code, before = 0, sys.stdin
    sys.stdin = io.TextIOWrapper(io.BytesIO((stdin or "").encode()), encoding="utf-8")
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                module.main([BOARD, *args])
            except SystemExit as stop:  # as the interpreter ends on it: a message goes to stderr and exits 1
                code = stop.code if isinstance(stop.code, int) else 0 if stop.code is None else 1
                if isinstance(stop.code, str):
                    print(stop.code, file=sys.stderr)
            except (OSError, ValueError, KeyError, TypeError) as error:  # board.py's own last line
                print(f"board: {error}", file=sys.stderr)
                code = 1
            except BaseException:  # a crash is a traceback and exit 1 there too
                traceback.print_exc()
                code = 1
    finally:
        sys.stdin = before
    # Read as subprocess reads text: any line ending comes back as a newline.
    return (code, *(stream.buffer.getvalue().decode().replace("\r\n", "\n").replace("\r", "\n") for stream in (out, err)))
