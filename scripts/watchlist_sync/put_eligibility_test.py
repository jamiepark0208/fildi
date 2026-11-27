import unittest
from put_eligibility import iv_rv_cautions, published_cautions, canonical_block_reason


class QualityCautions(unittest.TestCase):
    def test_new_generation_cannot_approve_old_contract(self):
        c = {'eligibility_source': 'canonical', 'engine': {'pass': True, 'is_pick': False}}
        self.assertIn('changed', canonical_block_reason(c))
        c['engine']['is_pick'] = True
        self.assertIsNone(canonical_block_reason(c))
        c['engine'].update({'pass': False, 'gates': ['earnings']})
        self.assertIn('earnings', canonical_block_reason(c))
        c.update(eligibility_source='strategy:panic-puts-hiv', engine={})
        self.assertIsNone(canonical_block_reason(c))

    def test_model_list_does_not_reject_scored_red_puts(self):
        from publish_model_list import held_back_reason
        self.assertIsNone(held_back_reason('sell_puts', {'verdict': 'red', 'risk': 1}, {}, -.2))
        self.assertEqual(held_back_reason('sell_puts', None, {}, None), 'not scored by the fit model')

    def test_l1_preserves_income_caution_but_still_blocks_earnings(self):
        from datetime import date, timedelta
        from build_plan_parts.checks import option_checks
        today = date.today()
        ctx = {k: {} for k in ['close', 'closes_by_date', 'earnings', 'lseg', 'tech']}
        ctx.update(snapshot_date=today, short_opts=set(), accounts=[{'nickname': 'fixture', 'bp': 100000}])
        r = dict(ticker='FIXTURE', side='put', restruck=True, bid_is_live=True, premium=.2,
                 delta=-.1, dte=7, strike_iv=.3, strike=100, spot=110, weekly_income_pct=.1,
                 expiry=today+timedelta(days=7), engine_cautions=['thin income'], engine_pause='market panic')
        checks, _ = option_checks(r, ctx)
        by = {c['check']: c for c in checks}
        self.assertEqual(by['min_income']['severity'], 'warn')
        self.assertEqual(by['eligibility_source']['detail'], 'canonical')
        self.assertEqual(by['engine_caution']['detail'], 'thin income')
        self.assertEqual(by['market_not_panic']['severity'], 'warn')
        ctx['earnings']['FIXTURE'] = today+timedelta(days=3)
        checks, _ = option_checks(r, ctx)
        er = next(c for c in checks if c['check']=='no_earnings_before_expiry')
        self.assertFalse(er['pass']); self.assertEqual(er['severity'], 'block')

    def test_boundary_and_unknown(self):
        self.assertTrue(iv_rv_cautions(.9499, .95))
        self.assertEqual(iv_rv_cautions(.95, .95), [])
        self.assertEqual(iv_rv_cautions(1.2, .95), [])
        for value in [None, float('nan'), float('inf'), 0]:
            self.assertIn('unavailable', iv_rv_cautions(value, .95)[0])
        self.assertEqual(iv_rv_cautions(None, 0), [])

    def test_same_contract_reuses_canonical_input_not_newer_local_ratio(self):
        c = {'engine': {'is_pick': True, 'quality_policy': {'version': 'test'},
                        'cautions': iv_rv_cautions(.9, .95)}, 'vol': {'contract_iv_rv': 1.2}}
        self.assertEqual(published_cautions(c, .95), c['engine']['cautions'])
        c['engine']['is_pick'] = False
        self.assertEqual(published_cautions(c, .95), [])

    def test_caution_is_not_an_instruction_to_block(self):
        for ratio in [.89, .73, .85]:
            self.assertIn('not a hard block', iv_rv_cautions(ratio, .95)[0])
