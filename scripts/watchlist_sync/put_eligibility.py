"""Shared contract-quality cautions. Hard safety gates remain in put_recs.
Jamie Nov17: judgment concerns stay visible; they do not silently exclude an idea.
"""
import math


def iv_rv_cautions(ratio, floor):
    if floor == 0:
        return []
    if not isinstance(floor, (int, float)) or not math.isfinite(floor) or floor < 0:
        return ["contract IV/RV policy unavailable — quality not assessed"]
    if not isinstance(ratio, (int, float)) or not math.isfinite(ratio) or ratio <= 0:
        return ["contract IV/RV unavailable — option richness not assessed"]
    if ratio < floor:
        return [f"contract IV/RV {ratio:.2f} below {floor:.2f}: premium is cheap versus recent realized moves; caution, not a hard block"]
    return []


def published_cautions(contract, floor):
    engine = contract.get("engine") or {}
    if engine.get("is_pick") and engine.get("quality_policy"):
        return list(engine.get("cautions") or [])
    return iv_rv_cautions((contract.get("vol") or {}).get("contract_iv_rv"), floor)


def canonical_block_reason(contract):
    """A prior verified plan cannot borrow today's approval for a different contract."""
    engine = contract.get("engine") or {}
    separate = contract.get("eligibility_source", "").startswith("strategy:")
    if not separate and engine.get("is_pick") is not True:
        return "canonical contract changed or unavailable; rebuild and verify the current plan"
    if engine.get("is_pick") is True and engine.get("pass") is False:
        return "engine hard gate: " + "; ".join(engine.get("gates") or ["not eligible"])
    return None
