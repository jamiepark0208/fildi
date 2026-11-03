"""Offline fault injection for A277's strict checker; no database connection."""
import contextlib
import hashlib
import io
import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/watchlist_sync'))
import put_consistency as checker


class EmptyConnection:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=()):
        self.sql = sql
        return self

    def fetchone(self):
        return (None,) if 'MIN(computed_at)' in self.sql else (None, None)

    def __iter__(self):
        return iter(())


output = io.StringIO()
exit_code = 0
with patch.object(checker, 'connect', return_value=EmptyConnection()), \
        patch.object(checker, 'rows', return_value=[]), \
        patch.object(sys, 'argv', ['put_consistency.py', '--strict']), \
        contextlib.redirect_stdout(output):
    try:
        checker.main()
    except SystemExit as exc:
        exit_code = exc.code

source = Path(checker.__file__)
result = {'source': str(source.relative_to(ROOT)),
          'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
          'case': 'All source tables empty must not pass strict verification',
          'actual_exit': exit_code, 'expected_exit': 1,
          'output': output.getvalue().strip(), 'pass': exit_code == 1}
print(json.dumps(result, indent=2))
sys.exit(0 if result['pass'] else 1)
