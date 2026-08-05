"""Native Windows process ancestry for MSYS/Git Bash, via Toolhelp32 + ctypes.

Generalized from firstmate-gui-agnostic's codex_desktop_ancestry.py: instead of
matching one hard-coded image name, match any harness image name given on the
command line.
"""
from __future__ import annotations

import argparse
import ctypes
import sys
from ctypes import wintypes
from pathlib import PureWindowsPath

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def snapshot():
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    h = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if h == wintypes.HANDLE(-1).value:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot failed")
    table = {}
    e = PROCESSENTRY32W()
    e.dwSize = ctypes.sizeof(e)
    try:
        ok = k.Process32FirstW(h, ctypes.byref(e))
        while ok:
            table[int(e.th32ProcessID)] = (int(e.th32ParentProcessID), e.szExeFile)
            ok = k.Process32NextW(h, ctypes.byref(e))
    finally:
        k.CloseHandle(h)
    return table


def chain(start, table, limit=64):
    pid, seen, out = start, set(), []
    for _ in range(limit):
        if pid <= 1 or pid in seen or pid not in table:
            break
        seen.add(pid)
        ppid, name = table[pid]
        out.append((pid, name))
        pid = ppid
    return out


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=int, required=True)
    p.add_argument("--match", default="")
    p.add_argument("--chain", action="store_true")
    a = p.parse_args(argv)
    table = snapshot()
    c = chain(a.start, table)
    if a.chain:
        for pid, name in c:
            print(f"{pid}\t{name}")
        return 0
    names = [n.lower() for n in a.match.split(",") if n]
    # outermost consecutive match, matching the lib's claude bg-spare rule
    best = None
    for pid, name in c:
        if PureWindowsPath(name).name.lower() in names:
            best = pid
        elif best is not None:
            break
    if best is None:
        return 1
    print(best)
    return 0


if __name__ == "__main__":
    sys.exit(main())
