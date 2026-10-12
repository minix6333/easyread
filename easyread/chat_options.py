"""Conversation-local overrides, independent of translation/model-card defaults."""
from . import cli_models


def apply(ecfg: dict, options: dict | None) -> dict:
    if not isinstance(options, dict):
        return {}
    out = {}
    effort = options.get("reasoning_effort")
    if effort is not None:
        allowed = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        engine = ecfg["engine"]
        if engine == "claude":
            allowed = [""] if "haiku" in ecfg[engine].get("model", "") else ["", "low", "medium", "high", "xhigh", "max"]
        elif engine == "codex":
            listing = cli_models.codex()
            model = ecfg[engine].get("model") or listing["default"]
            match = next((m for m in listing["models"] if m["id"] == model), {})
            if match.get("reasoning_levels"):
                allowed = ["", *match["reasoning_levels"]]
        if effort not in allowed:
            raise ValueError("Unsupported reasoning effort")
        ecfg[engine]["reasoning_effort"] = effort
        out["reasoning_effort"] = effort
    # 速度（Fast）：只有 Codex 和 API 有；"fast" 約兩倍速、額度用得快，"default" 是標準，"" 照模型卡片上設的
    tier = options.get("service_tier")
    if tier is not None and ecfg["engine"] in ("codex", "openai"):
        if tier not in ("", "fast", "default"):
            raise ValueError("Unsupported service tier")
        if tier:
            ecfg[ecfg["engine"]]["service_tier"] = tier
        out["service_tier"] = tier
    return out
