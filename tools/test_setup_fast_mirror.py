"""Tests for setup.py's fast host: hf-mirror.com when huggingface.co is slow from here, huggingface.co otherwise,
the same pinned revision and SHA-256 either way, and QUCHEN_FAST_MIRROR to choose.  Mocked network - nothing is
downloaded.

    python -m unittest tools.test_setup_fast_mirror
"""
from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import setup  # noqa: E402

REPO = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF"
REV = "a" * 40


class FastMirror(unittest.TestCase):
    def setUp(self):
        self._saved = dict(setup.os.environ)
        for name in ("HF_ENDPOINT", "QUCHEN_FAST_MIRROR", "QUCHEN_SOURCE"):
            setup.os.environ.pop(name, None)
        setup._fast_mirror.clear()

    def tearDown(self):
        setup.os.environ.clear()
        setup.os.environ.update(self._saved)
        setup._fast_mirror.clear()

    @staticmethod
    def latency(**values):
        def fake(host, timeout=4.0):
            return values.get(host, float("inf"))
        return mock.patch.object(setup, "host_latency", side_effect=fake)

    def test_the_mirror_is_used_when_huggingface_is_slow(self):
        with self.latency(**{setup.HF_MIRROR: 0.2, setup.HF_DEFAULT: 6.0}):
            self.assertEqual(setup.fast_mirror(), setup.HF_MIRROR)

    def test_huggingface_wins_when_it_answers_faster(self):
        with self.latency(**{setup.HF_MIRROR: 3.0, setup.HF_DEFAULT: 0.3}):
            self.assertEqual(setup.fast_mirror(), setup.HF_DEFAULT)

    def test_a_mirror_that_does_not_answer_is_not_used(self):
        with self.latency(**{setup.HF_DEFAULT: 5.0}):                 # the mirror stays inf
            self.assertEqual(setup.fast_mirror(), setup.HF_DEFAULT)

    def test_off_asks_nothing_and_keeps_huggingface(self):
        setup.os.environ["QUCHEN_FAST_MIRROR"] = "off"
        with self.latency(**{setup.HF_MIRROR: 0.1, setup.HF_DEFAULT: 9.0}) as probe:
            self.assertEqual(setup.fast_mirror(), setup.HF_DEFAULT)
        self.assertFalse(probe.called)

    def test_hf_mirror_insists_without_a_probe(self):
        setup.os.environ["QUCHEN_FAST_MIRROR"] = "hf-mirror"
        with self.latency(**{setup.HF_MIRROR: 9.0, setup.HF_DEFAULT: 0.1}) as probe:
            self.assertEqual(setup.fast_mirror(), setup.HF_MIRROR)
        self.assertFalse(probe.called)

    def test_a_named_endpoint_is_never_second_guessed(self):
        setup.os.environ["HF_ENDPOINT"] = "https://example.invalid"
        with mock.patch.object(setup, "host_latency") as probe, contextlib.redirect_stdout(io.StringIO()):
            setup.use_fast_mirror()
        self.assertFalse(probe.called)
        self.assertEqual(setup.hf_endpoint(), "https://example.invalid")

    def test_use_fast_mirror_points_this_run_at_the_mirror(self):
        with self.latency(**{setup.HF_MIRROR: 0.2, setup.HF_DEFAULT: 7.0}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            setup.use_fast_mirror()
            self.assertEqual(setup.hf_endpoint(), setup.HF_MIRROR)
            setup.use_fast_mirror()                                   # once per process: no second probe
        self.assertIn("hf-mirror.com", out.getvalue())

    def test_the_url_keeps_its_repository_revision_and_file(self):
        url = f"https://huggingface.co/{REPO}/resolve/{REV}/x.gguf"
        with self.latency(**{setup.HF_MIRROR: 0.2, setup.HF_DEFAULT: 7.0}), \
                contextlib.redirect_stdout(io.StringIO()):
            moved = setup.mirrored_url(url)
        self.assertEqual(moved, f"https://hf-mirror.com/{REPO}/resolve/{REV}/x.gguf")
        # the pins come from the path, so a mirrored URL is checked against the same size and SHA-256
        self.assertEqual(setup.file_pin(moved), setup.file_pin(url))

    def test_a_url_that_is_not_huggingface_is_left_alone(self):
        url = "https://github.com/quchenace/QuChen/releases/latest/download/quchen-windows-x64.zip"
        self.assertEqual(setup.mirrored_url(url), url)
        self.assertFalse(setup._fast_mirror)


if __name__ == "__main__":
    unittest.main()
