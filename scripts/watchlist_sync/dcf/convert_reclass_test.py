"""A288: if-converted + Claude revise guards (no SEC)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import financials as F  # noqa: E402


def reclass(face: float, conv_px: float, spot: float) -> tuple[float, float]:
    """Returns (debt_delta, shares_added). debt_delta is negative when reclassed."""
    if face <= 0 or conv_px <= 0 or spot <= conv_px:
        return 0.0, 0.0
    return -face, face / conv_px


def apply_guards(
    *,
    shares: float,
    rsu: float,
    opt_net: float,
    gap: float,
    convert_sh: float,
    reclassed_face: float,
    debt_sec: float,
) -> tuple[float, float, float, float]:
    """Mirrors engine.inputs dilution/convert guards. Returns (extra_sh, convert_sh, debt_sec, rsu)."""
    used_gap = False
    if gap > rsu + opt_net:
        rsu, opt_net = gap, 0.0
        used_gap = True
    if used_gap and convert_sh > 0:
        debt_sec += reclassed_face
        convert_sh = 0.0
        reclassed_face = 0.0
    if shares and (rsu + opt_net) >= 0.3 * shares:
        rsu, opt_net = 0.0, 0.0
    if shares and convert_sh >= 0.3 * shares:
        debt_sec += reclassed_face
        convert_sh = 0.0
    extra_sh = rsu + opt_net + convert_sh
    return extra_sh, convert_sh, debt_sec, rsu


def main() -> None:
    d, s = reclass(1_000_000_000, 20.0, 40.0)
    assert d == -1_000_000_000 and abs(s - 50_000_000) < 1e-6
    assert reclass(1e9, 20.0, 10.0) == (0.0, 0.0)
    assert reclass(1e9, 0.0, 40.0) == (0.0, 0.0)
    assert reclass(0.0, 20.0, 40.0) == (0.0, 0.0)

    # Finding 1: BABA-like gap ≥ 30% shares → zero rsu/opt; converts guarded separately
    extra, csh, debt, rsu = apply_guards(
        shares=1_850e6, rsu=667e6, opt_net=0.0, gap=667e6,
        convert_sh=0.0, reclassed_face=0.0, debt_sec=10e9,
    )
    assert rsu == 0.0 and extra == 0.0 and abs(debt - 10e9) < 1

    # Finding 3: gap path skips convert_sh and restores face
    extra, csh, debt, rsu = apply_guards(
        shares=100e6, rsu=1e6, opt_net=0.0, gap=5e6,
        convert_sh=10e6, reclassed_face=200e6, debt_sec=800e6,
    )
    assert csh == 0.0 and abs(debt - 1e9) < 1 and abs(extra - 5e6) < 1

    # Finding 2: convert-only absurd add restores face
    extra, csh, debt, rsu = apply_guards(
        shares=100e6, rsu=1e6, opt_net=0.0, gap=0.0,
        convert_sh=50e6, reclassed_face=200e6, debt_sec=800e6,
    )
    assert csh == 0.0 and abs(debt - 1e9) < 1 and abs(extra - 1e6) < 1

    # Happy path ITM convert kept
    extra, csh, debt, rsu = apply_guards(
        shares=100e6, rsu=1e6, opt_net=0.0, gap=0.0,
        convert_sh=5e6, reclassed_face=100e6, debt_sec=900e6,
    )
    assert abs(csh - 5e6) < 1 and abs(extra - 6e6) < 1 and abs(debt - 900e6) < 1

    # A288 11-03: BABA FY2026 20-F dei mis-scaled; basic/8 ADS matches fmp 2,321M
    ads, ratio = F.adr_ads_shares(dei=1_858_037_427, basic=18_568_000_000, fmp_sh=2_321_000_000)
    assert ratio == 8 and ads is not None and abs(ads - 2_321_000_000) / 2_321_000_000 < 0.001

    print("convert_reclass_test: ok")


if __name__ == "__main__":
    main()
