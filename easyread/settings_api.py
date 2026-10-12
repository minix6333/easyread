"""设置页的保存类接口（POST）。server.py 按路径转过来，每个函数收请求体、返回要回给页面的 JSON。"""
from __future__ import annotations

from . import chat_models, config, engines, langs, openai_api
from .i18n import tr


def save_config(patch: dict) -> dict:
    patch.pop("library_dir", None)
    if "page_cap" in patch and (type(patch["page_cap"]) is not int or patch["page_cap"] < 0):
        raise ValueError(tr("页数确认上限必须是非负整数"))
    if "target" in patch:
        patch["target"] = langs.valid(patch["target"])
    if isinstance(patch.get("openai"), dict):
        patch["openai"] = config.with_key(patch["openai"])
    if "auto_translate" in patch:
        patch["auto_translate"] = patch["auto_translate"] is True
    if "preread" in patch:  # 匯入時讓 AI 先讀過整份（preread.py）
        patch["preread"] = patch["preread"] is True
    if "quick" in patch:  # 選字翻譯用的模型（「問 AI」名單裡的 id，空著跟預設）
        q = patch["quick"] if isinstance(patch["quick"], dict) else {}
        patch["quick"] = {"translate_model": str(q.get("translate_model") or "")[:60]}
    return {"config": config.public(config.save(patch))}


def save_chat_models(body: dict) -> dict:
    """保存“问 AI”的名单和默认模型；或面板里只改默认。"""
    patch = {}
    if "models" in body:
        patch["models"] = chat_models.sanitize(body["models"])
    if body.get("default"):
        patch["default"] = str(body["default"])
    full = {"chat": patch}
    if isinstance(body.get("keys"), dict):  # 设置里给某家 API 填的 Key，和翻译那边共用
        keys = dict(config.load()["openai"].get("keys") or {})
        keys.update({str(k): str(v).strip() for k, v in body["keys"].items() if v and not str(v).startswith("••••")})
        full["openai"] = {"keys": keys}
    config.save(full)
    return chat_models.listing(config.load())


def set_chat_model_option(body: dict) -> dict:
    """「問 AI」的模型選單裡直接開關 Fast：改的就是設定裡那張模型卡片（只有一個地方記），卡片上的翻譯標記跟著走。"""
    cfg = config.load()
    tier = body.get("service_tier")
    if tier not in ("", "fast", "default"):
        raise ValueError(tr("速度只能是 fast / default"))
    ms = [dict(m) for m in chat_models.models(cfg)]
    hit = next((m for m in ms if m.get("id") == body.get("id")), None)
    if not hit or hit.get("engine") not in ("codex", "openai"):
        raise ValueError(tr("這個模型沒有 Fast"))
    was_translation = chat_models.translation_id(cfg) == hit["id"]
    hit["service_tier"] = tier
    patch: dict = {"chat": {"models": chat_models.sanitize(ms)}}
    if was_translation:  # 這張卡片同時是翻譯用的模型：翻譯那邊一起改，卡片上的「翻譯」標記才不會掉
        patch[hit["engine"]] = {"service_tier": tier}
    config.save(patch)
    return chat_models.listing(config.load())


def test_engine(body: dict) -> dict:
    cfg = config.load()
    if body.get("engine"):
        cfg["engine"] = body["engine"]
    return engines.test(cfg)


def list_models(body: dict) -> dict:
    """设置页“获取模型列表”：{base_url, preset, api_key}；Key 留空或打码时用这家已存的。"""
    key = str(body.get("api_key") or "").strip()
    if not key or key.startswith("••••"):
        key = (config.load()["openai"].get("keys") or {}).get(str(body.get("preset") or ""), "")
    try:
        return {"ok": True, "models": openai_api.models({"base_url": body.get("base_url"), "api_key": key})}
    except engines.EngineError as e:
        return {"ok": False, "message": str(e)[:300]}


POST = {"/api/config": save_config, "/api/chat/models": save_chat_models, "/api/chat/model-option": set_chat_model_option,
        "/api/config/test": test_engine, "/api/models/list": list_models}
