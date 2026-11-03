"""Fixture test for A329 L2 band — hand-check: gold 0.20 truth 0.22 margin → pass (same as A318-judge)."""

FRACTION = {"grossMargin", "netMargin", "operatingMargin", "returnOnAssets", "dividendYield"}


def ok(v, t, field):
    if v is None or t is None:
        return None
    band = max(abs(t) * 0.20, 0.03 if field in FRACTION else 0)
    return abs(v - t) <= band


def test_ok_margin_hand_check():
    assert ok(0.20, 0.22, "netMargin") is True
    assert ok(0.20, 0.30, "netMargin") is False


if __name__ == "__main__":
    test_ok_margin_hand_check()
    print("ok")
