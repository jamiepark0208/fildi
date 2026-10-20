import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import oj

class Usage(unittest.TestCase):
    def test_only_numeric_usage_is_retained(self):
        with tempfile.TemporaryDirectory() as d, patch.object(oj,'USAGE',Path(d)/'usage'), patch.object(oj,'me',return_value='codex'):
            oj.log_request_usage({'usage':{'input_tokens':123,'output_tokens':0,'secret':'PRIVATE'},'answers':'PRIVATE'},12)
            text=oj.USAGE.read_text();row=json.loads(text)
            self.assertNotIn('PRIVATE',text)
            self.assertEqual(row['input_tokens'],123)
            self.assertEqual(row['output_tokens'],0)
            self.assertNotIn('id',row)
    def test_missing_or_invalid_tokens_stay_unknown(self):
        with tempfile.TemporaryDirectory() as d, patch.object(oj,'USAGE',Path(d)/'usage'), patch.object(oj,'me',return_value='untrusted-private-name'):
            oj.log_request_usage({'usage':{'input_tokens':True,'output_tokens':-1}},0)
            row=json.loads(oj.USAGE.read_text())
            self.assertIsNone(row['input_tokens']);self.assertIsNone(row['output_tokens']);self.assertEqual(row['agent'],'?')
if __name__=='__main__':unittest.main()
