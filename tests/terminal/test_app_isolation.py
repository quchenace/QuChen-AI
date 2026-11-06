"""The desktop app never adopts an older command-line QuChen install (tester report 2026-10-17: the app wrote
quchen-gyro-gyro-s.log/.json into the tester's old T:\\QuChen). The app points Control and the installer at a settings file of its
own (QUCHEN_SETTINGS_FILE); the shared %APPDATA% / ~/.config file with the old install's folders is not read."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from quchen_control import models  # noqa: E402
import setup as quchen_setup  # noqa: E402


class AppIsolation(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        base = Path(self.dir.name)
        self.old = base / "T-QuChen"
        self.old.mkdir()
        (self.old / "quchen-gyro-gyro-s.json").write_text(json.dumps({"exe": "quchen.exe", "tokenizer": "t", "args": []}))
        shared = base / "appdata" / "QuChen"
        shared.mkdir(parents=True)
        (shared / "settings.json").write_text(json.dumps({"installs": [str(self.old)], "data_dir": str(base / "T-data")}))
        (base / "xdg" / "quchen").mkdir(parents=True)
        (base / "xdg" / "quchen" / "settings.json").write_text(json.dumps({"installs": [str(self.old)], "data_dir": str(base / "T-data")}))
        self.app_data = base / "app" / "QuChen"
        self.app_data.mkdir(parents=True)
        self.env = {"APPDATA": str(base / "appdata"), "XDG_CONFIG_HOME": str(base / "xdg"),
                    "LOCALAPPDATA": str(base / "local"), "XDG_DATA_HOME": str(base / "xdg-data"), "QUCHEN_COMPONENTS_DIR": ""}
        self.base = base
        self.terminal = base / "terminal"
        self.terminal.mkdir()

    def test_the_terminal_still_remembers_the_old_install(self):
        with mock.patch.dict(os.environ, self.env), mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(models, "ROOT", self.terminal):
            os.environ.pop("QUCHEN_SETTINGS_FILE", None)
            os.environ.pop("QUCHEN_INSTALL_DIR", None)
            self.assertEqual(models.resolve_install(), (self.old.resolve(), "remembered"))

    def test_the_app_does_not(self):
        env = {**self.env, "QUCHEN_SETTINGS_FILE": str(self.app_data / "app-settings.json")}
        with mock.patch.dict(os.environ, env), mock.patch.object(models, "ROOT", self.terminal):
            os.environ.pop("QUCHEN_INSTALL_DIR", None)
            self.assertEqual(models.settings_path(), self.app_data / "app-settings.json")
            self.assertEqual(models.remembered_installs(), [])
            # no older install is adopted: with nothing of its own yet the app gets its own install folder (beside its components folder)
            found, how = models.resolve_install()
            self.assertEqual(how, "default")
            self.assertNotEqual(found, self.old.resolve())
            self.assertEqual(quchen_setup.settings_path(), self.app_data / "app-settings.json")
            self.assertEqual(quchen_setup.load_settings(), {})
            # the installer's own list of "other installs" has no sibling scan and no shared settings
            self.assertEqual(quchen_setup.other_installs(quchen_setup.load_settings()), [])

    def test_saving_settings_goes_to_the_app_file_only(self):
        env = {**self.env, "QUCHEN_SETTINGS_FILE": str(self.app_data / "app-settings.json")}
        shared = self.base / "appdata" / "QuChen" / "settings.json"
        before = shared.read_bytes()
        with mock.patch.dict(os.environ, env):
            quchen_setup.save_settings({"data_dir": str(self.app_data / "data")})
        self.assertEqual(shared.read_bytes(), before)
        self.assertIn("data_dir", json.loads((self.app_data / "app-settings.json").read_text()))


if __name__ == "__main__":
    unittest.main()
