"""Per-user state locations: %LOCALAPPDATA%\\QuChen on Windows, $XDG_STATE_HOME/quchen elsewhere."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from quchen_cli.cli import main
from quchen_control import paths, runtime


class StatePaths(unittest.TestCase):
    def test_windows_uses_localappdata(self):
        env = {"LOCALAPPDATA": "C:\\Users\\me\\AppData\\Local", "XDG_STATE_HOME": "/ignored"}
        self.assertEqual(paths.state_base(env, windows=True, home=Path("C:\\Users\\other")),
                         Path("C:\\Users\\me\\AppData\\Local") / "QuChen")

    def test_windows_without_localappdata_falls_back_to_the_profile(self):
        self.assertEqual(paths.state_base({}, windows=True, home=Path("C:\\Users\\me")),
                         Path("C:\\Users\\me") / "AppData" / "Local" / "QuChen")

    def test_posix_is_unchanged(self):
        self.assertEqual(paths.state_base({"XDG_STATE_HOME": "/x"}, windows=False), Path("/x") / "quchen")
        self.assertEqual(paths.state_base({}, windows=False, home=Path("/home/me")),
                         Path("/home/me") / ".local" / "state" / "quchen")

    def test_runtime_dir_default_lives_under_the_state_base(self):
        with tempfile.TemporaryDirectory() as d:
            env = {"LOCALAPPDATA": d, "XDG_STATE_HOME": d}
            with mock.patch.dict(os.environ, env):
                os.environ.pop("QUCHEN_RUNTIME_DIR", None)
                self.assertEqual(runtime.runtime_dir(), paths.state_base() / "runtime")
                self.assertEqual(runtime.runtime_dir().parent.parent, Path(d))

    def test_cli_defaults_for_tuning_and_timeskip_follow_the_same_base(self):
        with tempfile.TemporaryDirectory() as d:
            env = {"LOCALAPPDATA": d, "XDG_STATE_HOME": d}
            with mock.patch.dict(os.environ, env):
                for var in ("QUCHEN_TUNE_DIR", "QUCHEN_TIMESKIP_DIR"):
                    os.environ.pop(var, None)
                self.assertEqual(main(["tune", "list", "--output", "json"]), 0)
                self.assertEqual(main(["timeskip", "list", "--output", "json"]), 0)


if __name__ == "__main__":
    unittest.main()
