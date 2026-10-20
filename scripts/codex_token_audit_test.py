import importlib.util
import json
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('audit',Path(__file__).with_name('codex-token-audit.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Audit(unittest.TestCase):
    def test_deduplicates_responses_and_ignores_cumulative_snapshots(self):
        row={'type':'token_usage_record','payload':{'turn_id':'PRIVATE','response_id':'r1','usage':{'input_tokens':100,'cached_input_tokens':80,'output_tokens':10,'reasoning_output_tokens':4},'thread_token_usage':{'input_tokens':9000}}}
        result=module.audit([row,row,{'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':9999}}}}])
        self.assertEqual(result['total']['input'],100)
        self.assertEqual(result['total']['output'],10)
        self.assertEqual(result['total']['uncached_input'],20)
        self.assertNotIn('PRIVATE',json.dumps(result))
    def test_output_content_and_arbitrary_tool_names_never_escape(self):
        result=module.audit([{'type':'response_item','payload':{'type':'function_call','call_id':'c','name':'SECRET'}},{'type':'response_item','payload':{'type':'function_call_output','call_id':'c','output':'PRIVATE'}}])
        self.assertEqual(result['tool_outputs'][0]['characters'],7)
        self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('PRIVATE',json.dumps(result))
if __name__=='__main__':unittest.main()
