"""A200 mute rule — >30% of assignments flagged → suppress Portfolio Alert."""
from __future__ import annotations


def should_mute(n_flags: int, n_assignments: int) -> bool:
    return n_assignments > 0 and n_flags / n_assignments > 0.30


def main() -> None:
    assert should_mute(0, 100) is False
    assert should_mute(30, 100) is False  # exactly 30% stays on
    assert should_mute(31, 100) is True
    assert should_mute(5, 0) is False
    print("peer_drift_mute_test: ok")


if __name__ == "__main__":
    main()
