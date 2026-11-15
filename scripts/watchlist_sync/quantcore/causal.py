"""Generic look-ahead detector (Jamie 11-15).

A function f(data) → per-bar output is causal iff f(data[:t])[:t] == f(data)[:t] for every cut t.
Any difference means bar < t used data from ≥ t (A374 H2, A375 H2/H3, the fill-bar bugs were all this).

    assert_causal(lambda c: ta.rsi(c, 14), closes)
    assert_causal(lambda df: entry_mask(df), frame, slicer=lambda df, t: df.iloc[:t])
"""
from __future__ import annotations

from typing import Any, Callable

import numpy as np


class LookAheadError(AssertionError):
    pass


def _arr(x) -> np.ndarray:
    if hasattr(x, "to_numpy"):
        x = x.to_numpy()
    return np.asarray(x, dtype=float)


def assert_causal(f: Callable[[Any], Any], data: Any, *, cuts: list[int] | None = None,
                  slicer: Callable[[Any, int], Any] | None = None, atol: float = 1e-9, n_cuts: int = 12,
                  seed: int = 0) -> None:
    n = len(data)
    if n < 3:
        return
    sl = slicer or (lambda d, t: d[:t])
    full = _arr(f(data))
    if cuts is None:
        rng = np.random.default_rng(seed)
        cuts = sorted(set(int(c) for c in rng.integers(2, n, size=n_cuts)) | {n // 2, n - 1})
    for t in cuts:
        part = _arr(f(sl(data, t)))
        a, b = part[:t], full[:t]
        both_nan = np.isnan(a) & np.isnan(b)
        diff = ~both_nan & ~(np.abs(a - b) <= atol)
        if diff.any():
            i = int(np.argmax(diff.reshape(len(a), -1).any(axis=1)))
            raise LookAheadError(f"output at bar {i} changes when data is cut at {t}: {b.reshape(len(b), -1)[i]} → "
                                 f"{a.reshape(len(a), -1)[i]} (uses future bars)")
