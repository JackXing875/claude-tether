#!/usr/bin/env python3
"""Own and reap one launch's descendants without a private PID namespace."""
import ctypes
import os
import signal
import subprocess
import sys
import time


def main():
    if sys.platform != "linux" or sys.version_info < (3, 9):
        raise RuntimeError("host process mode requires Linux and Python >= 3.9")
    stopping = 0

    def stop(signum, _frame):
        nonlocal stopping
        # The terminal sends Ctrl+C to the entire foreground group, including
        # Claude. Let Claude cancel a prompt without ending its session.
        if signum == signal.SIGINT and os.isatty(0):
            return
        stopping = stopping or signum

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    # Explicitly retain zombies until waitpid, even if a caller ignored SIGCHLD.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    libc = ctypes.CDLL(None, use_errno=True)
    for option, value in ((36, 1), (1, signal.SIGTERM)):  # CHILD_SUBREAPER, PDEATHSIG
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "cannot enable descendant supervision")
    children_file = f"/proc/self/task/{os.getpid()}/children"

    def children():
        with open(children_file, encoding="ascii") as stream:
            return [int(pid) for pid in stream.read().split()]

    children()  # Fail before launching anything if procfs is unavailable.
    if sys.argv[1:] == ["--check"]:
        return 0
    if len(sys.argv) < 5 or sys.argv[1] != "--parent" or sys.argv[3] != "--":
        raise RuntimeError("invalid supervisor arguments")
    # Covers the race where the launcher died before PDEATHSIG was installed.
    if stopping or os.getppid() != int(sys.argv[2]):
        return 128 + (stopping or signal.SIGTERM)
    child = subprocess.Popen(sys.argv[4:], close_fds=True)
    main_status = None
    cleanup_started = None
    terminated = set()
    while True:
        # Do not reap between a direct-child snapshot and signaling that child:
        # even an exited child retains its PID until we reap it. No global PID
        # scans, name matching, process-group kills or unrelated host jobs.
        has_children = True
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                has_children = False
                pid = 0
            if not pid:
                break
            terminated.discard(pid)
            if pid == child.pid:
                main_status = os.waitstatus_to_exitcode(status)
                child.returncode = main_status
        if main_status is not None or stopping:
            if cleanup_started is None:
                cleanup_started = time.monotonic()
            if not has_children:
                break
            # /proc's child list can change during iteration. Only ECHILD from
            # waitpid proves the tree is empty; an empty snapshot does not.
            remaining = children()
            elapsed = time.monotonic() - cleanup_started
            for pid in remaining:
                try:
                    if elapsed >= 1:
                        os.kill(pid, signal.SIGKILL)
                    elif pid not in terminated:
                        os.kill(pid, signal.SIGTERM)
                        terminated.add(pid)
                except ProcessLookupError:
                    pass
            # Orphans (including setsid/double-fork tools) become our children
            # and are handled on subsequent iterations.
            if elapsed >= 5:
                raise RuntimeError("descendants did not exit after SIGKILL; check host processes")
        time.sleep(0.02)
    if stopping:
        return 128 + stopping
    return main_status if main_status >= 0 else 128 - main_status


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"[tether] Process supervisor: {error}", file=sys.stderr)
        sys.exit(1)
