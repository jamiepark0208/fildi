"""A288: if-converted math (no SEC). ITM → debt −= face, shares += face÷cpx."""
from __future__ import annotations


def reclass(face: float, conv_px: float, spot: float) -> tuple[float, float]:
    """Returns (debt_delta, shares_added). debt_delta is negative when reclassed."""
    if face <= 0 or conv_px <= 0 or spot <= conv_px:
        return 0.0, 0.0
    return -face, face / conv_px


def main() -> None:
    d, s = reclass(1_000_000_000, 20.0, 40.0)
    assert d == -1_000_000_000 and abs(s - 50_000_000) < 1e-6
    assert reclass(1e9, 20.0, 10.0) == (0.0, 0.0)  # OTM
    assert reclass(1e9, 0.0, 40.0) == (0.0, 0.0)  # missing price
    assert reclass(0.0, 20.0, 40.0) == (0.0, 0.0)
    print("convert_reclass_test: ok")


if __name__ == "__main__":
    main()
