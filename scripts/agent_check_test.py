import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_check import run


class CheckTests(unittest.TestCase):
    def capture(self, code, inputs=(), timeout=5):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = run([sys.executable, "-c", code], inputs, timeout)
        text = output.getvalue()
        receipt = json.loads(Path(text.split("Receipt: ")[-1].strip()).read_text())
        self.assertLess(len(text), 4100)
        return status, text, receipt

    def test_noisy_failure_preserves_early_error_and_full_log(self):
        status, text, receipt = self.capture(
            "print('ERROR early sentinel'); print('ordinary line\\n'*10000); raise SystemExit(7)")
        self.assertEqual(status, 7)
        self.assertIn("ERROR early sentinel", text)
        self.assertGreater(receipt["log_bytes"], 100000)
        self.assertIn("ordinary line", Path(receipt["log"]).read_text())

    def test_change_during_check_invalidates_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.txt"
            path.write_text("before")
            _, _, receipt = self.capture(
                f"from pathlib import Path; Path({str(path)!r}).write_text('after')", [path])
            self.assertFalse(receipt["declared_inputs_unchanged"])

    def test_unchanged_and_missing_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.txt"
            path.write_text("fixed")
            status, _, receipt = self.capture("print('2 checks passed')", [path])
            self.assertEqual(status, 0)
            self.assertTrue(receipt["declared_inputs_unchanged"])
            with self.assertRaises(FileNotFoundError):
                self.capture("raise AssertionError('must not execute')", [path.parent / "missing"])

    def test_timeout_is_failure(self):
        status, _, receipt = self.capture("import time; time.sleep(30)", timeout=.05)
        self.assertEqual(status, 124)
        self.assertTrue(receipt["timed_out"])

    def test_invalid_timeout_never_launches_command(self):
        with patch("agent_check.subprocess.Popen") as launch:
            for timeout in (float("nan"), float("inf"), -1, 0):
                with self.assertRaises(ValueError):
                    run([sys.executable, "-c", "raise AssertionError"], timeout=timeout)
            launch.assert_not_called()

    def test_cli_preserves_arguments_and_does_not_start_model(self):
        runner = Path(__file__).with_name("oj.py")
        result = subprocess.run(
            [sys.executable, str(runner), "run", "--local", "--", sys.executable,
             "-c", "import sys; print(repr(sys.argv[1:]))", "a b", "--", "$(never execute)"],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("['a b', '--', '$(never execute)']", result.stdout)


if __name__ == "__main__":
    unittest.main()
