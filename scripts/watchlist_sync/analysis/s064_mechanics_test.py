"""Buy-zone mechanics regressions; no database or vendor access."""
import ast
import calendar
import math
import sys
import unittest
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from weekly_put_calendar import weekly_sessions

SOURCE = Path(__file__).with_name('s064_buy_zone.py')

class BuyZoneMechanics(unittest.TestCase):
    def setUp(self):
        def third_friday(y, m):
            return date(y, m, [w[calendar.FRIDAY] for w in calendar.monthcalendar(y,m) if w[calendar.FRIDAY]][2])
        self.ns = dict(math=math, date=date, timedelta=timedelta, lru_cache=lru_cache,
                       weekly_sessions=weekly_sessions, third_friday=third_friday,
                       split_factor=lambda *a:1, anchors=lambda *a:{'test':95}, bs_put=lambda *a:1)
        names={'pick_expiry','holding_dates','sell_put','trade'}
        funcs=[n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef) and n.name in names]
        exec(compile(ast.Module(body=funcs,type_ignores=[]),str(SOURCE),'exec'),self.ns)

    def rows(self):
        return [(d,100.,101.,99.,1000.,30.) for d in self.ns['holding_dates'](date(2026,1,5))]

    def trade(self, rows):
        self.ns['sell_put']=lambda *a:(95.,1.,None)
        return self.ns['trade'](None,None,'TEST',rows,0,(True,'pass'),{})

    def test_valid_window_preserves_trade(self):
        out=self.trade(self.rows())
        self.assertEqual(len(out),1)
        self.assertAlmostEqual(out[0]['put'],1/95)
        self.assertEqual(out[0]['e'],date(2026,2,20))

    def test_missing_expiry_rejected(self):
        self.assertEqual(self.trade([r for r in self.rows() if r[0]!=date(2026,2,20)]+[(date(2026,4,9),100,101,99,1000,30)]),[])

    def test_gap_cannot_shift_day63(self):
        rows=self.rows();del rows[8];rows.append((date(2026,4,9),100,101,99,1000,30))
        self.assertEqual(self.trade(rows),[])

    def test_good_friday_expiry_is_thursday(self):
        self.assertEqual(self.ns['pick_expiry'](date(2025,3,10)),date(2025,4,17))

    def test_fallback_delta_checked_before_quote(self):
        op=Mock();op.history.return_value=None
        self.ns.update(OP=op,put_delta=lambda s,k,v,t:-.11 if k==101 else -.09)
        self.assertIsNone(self.ns['sell_put'](object(),None,'TEST',date(2026,1,5),110,30,101,date(2026,2,20)))
        self.assertEqual([c.args[-1] for c in op.history.call_args_list],[101])

    def test_calendar_unsupported_fails_closed(self):
        self.assertEqual(self.ns['holding_dates'](date(2028,1,3)),())

if __name__=='__main__':unittest.main()
