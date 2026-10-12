"""Targeted checks for issue #19; no live model calls."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from easyread import config, chat_models, cli_models, engines


class CodexTranslationOptionsTest(unittest.TestCase):
    def test_cli_overrides_and_legacy_defaults(self):
        for options in ({}, {"model": "example", "reasoning_effort": "low", "service_tier": "fast"},
                        {"service_tier": "default"}):
            with self.subTest(options=options), patch.object(engines, "codex_path", return_value="codex"), \
                    patch.object(engines, "_popen") as popen, patch.object(engines, "_communicate") as communicate:
                def finish(*args):
                    argv = popen.call_args.args[0]
                    Path(argv[argv.index("-o") + 1]).write_text("translated", encoding="utf-8")
                    return ""
                communicate.side_effect = finish
                self.assertEqual(engines.run_codex(options, "translate", Path.cwd(), []), "translated")
                argv = popen.call_args.args[0]
                if not options:
                    self.assertNotIn("-c", argv)
                if options.get("reasoning_effort"):
                    self.assertIn('model_reasoning_effort="low"', argv)
                    self.assertEqual(argv[argv.index("--model") + 1], "example")
                if options.get("service_tier"):
                    self.assertIn('service_tier=' + json.dumps(options["service_tier"]), argv)

    def test_translation_options_do_not_change_chat_model(self):
        cfg = copy.deepcopy(config.DEFAULTS)
        cfg["codex"].update(reasoning_effort="max", service_tier="fast")
        out, _ = chat_models.engine_cfg(cfg, "gpt")
        self.assertEqual(out["codex"]["reasoning_effort"], "")
        self.assertEqual(out["codex"]["service_tier"], "")
        self.assertEqual(cfg["codex"]["reasoning_effort"], "max")

    def test_cache_and_persistence(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"CODEX_HOME": tmp}), \
                patch.object(config, "CONFIG_PATH", Path(tmp) / "easyread.json"):
            Path(tmp, "config.toml").write_text('model = "example"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\n', encoding="utf-8")
            Path(tmp, "models_cache.json").write_text(json.dumps({"models": [{"slug": "example", "visibility": "list",
                "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]}]}), encoding="utf-8")
            listing = cli_models.codex()
            self.assertEqual(listing["default"], "example")
            self.assertEqual(listing["configured_reasoning"], "high")
            self.assertEqual(listing["configured_tier"], "fast")
            self.assertEqual(listing["models"][0]["reasoning_levels"], ["low", "high"])
            config.save({"codex": {"reasoning_effort": "low", "service_tier": "default"}})
            self.assertEqual(config.load()["codex"]["reasoning_effort"], "low")
            self.assertEqual(config.load()["codex"]["service_tier"], "default")

    def test_fast_switch_in_the_chat_menu_edits_the_model_card(self):
        from easyread import settings_api
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"CODEX_HOME": tmp}), \
                patch.object(config, "CONFIG_PATH", Path(tmp) / "easyread.json"):
            Path(tmp, "models_cache.json").write_text(json.dumps({"models": [
                {"slug": "sol", "visibility": "list", "service_tiers": [{"id": "priority", "name": "Fast", "description": "2x speed, increased usage"}]},
                {"slug": "luna", "visibility": "list", "additional_speed_tiers": ["fast"]}, {"slug": "old", "visibility": "list"}]}), encoding="utf-8")
            self.assertEqual([m["fast"] for m in cli_models.codex()["models"]], [2.0, 1.5, 0])  # 快幾倍；沒有這個等級是 0
            config.save({"engine": "codex", "codex": {"model": "sol", "reasoning_effort": "low", "service_tier": ""},
                         "chat": {"models": [{"id": "a", "name": "Sol", "engine": "codex", "model": "sol", "reasoning_effort": "low", "service_tier": ""},
                                             {"id": "b", "name": "Sol 中", "engine": "codex", "model": "sol", "reasoning_effort": "medium", "service_tier": ""},
                                             {"id": "c", "name": "Opus", "engine": "claude", "model": "opus"}], "default": "b"}})
            self.assertEqual(chat_models.translation_id(config.load()), "a")
            out = settings_api.set_chat_model_option({"id": "b", "service_tier": "fast"})
            self.assertEqual({m["id"]: m.get("service_tier") for m in out["models"]}, {"a": "", "b": "fast", "c": ""})
            self.assertEqual(config.load()["codex"]["service_tier"], "")  # 別張卡片、翻譯用的設定不動
            ecfg, _ = chat_models.engine_cfg(config.load(), "b")
            self.assertEqual(ecfg["codex"]["service_tier"], "fast")
            # 這張卡片同時是翻譯用的：翻譯那邊一起改，卡片上的「翻譯」標記才不會掉
            settings_api.set_chat_model_option({"id": "a", "service_tier": "fast"})
            self.assertEqual(config.load()["codex"]["service_tier"], "fast")
            self.assertEqual(chat_models.translation_id(config.load()), "a")
            for bad in ({"id": "c", "service_tier": "fast"}, {"id": "b", "service_tier": "warp"}, {"id": "nope", "service_tier": "fast"}):
                with self.assertRaises(ValueError):
                    settings_api.set_chat_model_option(bad)

    def test_official_openai_api_gets_priority_not_fast(self):
        from easyread import openai_api
        o = {"model": "example", "api": "responses", "service_tier": "fast", "base_url": "https://api.openai.com/v1"}
        self.assertEqual(openai_api._body(o, "hi", [], False, None)["service_tier"], "priority")
        o["base_url"] = "https://example.test/v1"
        self.assertEqual(openai_api._body(o, "hi", [], False, None)["service_tier"], "fast")

    def test_settings_ui(self):
        subprocess.run(["node", "--test", "tests/test_codex_translation_options.cjs"], check=True)

    def test_claude_explicit_effort(self):
        with patch.object(engines, "claude_path", return_value="claude"), patch.object(engines, "_popen") as popen, \
                patch.object(engines, "_communicate", return_value='{"type":"result","result":"ok"}'):
            engines.run_claude({"model": "opus", "reasoning_effort": "low"}, "test", Path.cwd())
            argv = popen.call_args.args[0]
            self.assertEqual(argv[argv.index("--effort") + 1], "low")

    def test_card_effort_survives_save_and_chat_selection(self):
        cfg = copy.deepcopy(config.DEFAULTS)
        cfg["chat"]["models"] = chat_models.sanitize([{"id": "a", "engine": "claude", "model": "opus", "reasoning_effort": "max"}])
        out, _ = chat_models.engine_cfg(cfg, "a")
        self.assertEqual(out["claude"]["reasoning_effort"], "max")

    def test_api_effort_request_formats(self):
        from easyread import openai_api
        for api in ("chat", "responses"):
            o = {"model": "example", "api": api, "reasoning_effort": "low", "service_tier": "fast"}
            body = openai_api._body(o, "test", [], False, 0.2)
            self.assertEqual(body.get("reasoning", {}).get("effort") if api == "responses" else body["reasoning_effort"], "low")
            self.assertEqual(body["service_tier"], "fast")
            self.assertNotIn("temperature", body)
            body = openai_api._body({"model": "example", "api": api}, "test", [], False, None)
            self.assertNotIn("reasoning", body)
            self.assertNotIn("reasoning_effort", body)
            self.assertNotIn("service_tier", body)
