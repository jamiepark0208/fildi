#!/usr/bin/env python3
"""Local numeric audit of one explicitly selected Codex rollout. Never print transcript text."""
import argparse
import collections
import json
import statistics


def audit(records):
    turns, seen, calls = {}, set(), {}
    outputs = collections.defaultdict(list)
    for record in records:
        payload = record.get('payload', {})
        if record.get('type') == 'token_usage_record':
            response = payload.get('response_id')
            if not response or response in seen:
                continue
            seen.add(response)
            key = payload.get('turn_id')
            turn = turns.setdefault(key, dict(turn=len(turns)+1, first_at=record.get('timestamp'), requests=0,
                                              input=0, cached_input=0, output=0, contexts=[]))
            usage = payload.get('usage', {})
            count = lambda field: max(0, usage.get(field, 0)) if type(usage.get(field, 0)) is int else 0
            turn['input'] += count('input_tokens')
            turn['cached_input'] += count('cached_input_tokens')
            turn['output'] += count('output_tokens')
            turn['requests'] += 1
            turn['contexts'].append(count('input_tokens'))
        if record.get('type') == 'response_item':
            kind = payload.get('type')
            if kind in ('function_call', 'custom_tool_call'):
                # Fixed categories; arbitrary tool names might themselves contain private text.
                name = payload.get('name', '')
                category = name if name in ('exec_command','run','js','exec','apply_patch','get_usage_limits','write_stdin') else 'other'
                calls[payload.get('call_id')] = category
            elif kind in ('function_call_output', 'custom_tool_call_output'):
                value = payload.get('output', '')
                size = len(value if isinstance(value, str) else json.dumps(value))
                outputs[calls.get(payload.get('call_id'), 'other')].append(size)
    total = {k: sum(t[k] for t in turns.values()) for k in ('input','cached_input','output','requests')}
    total['uncached_input'] = max(0, total['input']-total['cached_input'])
    total['cached_percent'] = round(100*total['cached_input']/total['input'], 2) if total['input'] else None
    for turn in turns.values():
        turn['median_context'] = statistics.median(turn.pop('contexts'))
        turn['uncached_input'] = max(0, turn['input']-turn['cached_input'])
    return dict(total=total, turns=list(turns.values()), tool_outputs=sorted([
        dict(category=k, responses=len(v), characters=sum(v), largest_characters=max(v)) for k,v in outputs.items()
    ], key=lambda x:x['characters'], reverse=True),
        scope='Selected rollout only; excludes other agents/chats. Characters are not token counts. No plan-cost conversion.')


def records(path):
    with open(path) as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except ValueError:
                continue


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('rollout', help='Explicit local rollout file; never sent elsewhere')
    args = parser.parse_args()
    print(json.dumps(audit(records(args.rollout)), indent=2))
