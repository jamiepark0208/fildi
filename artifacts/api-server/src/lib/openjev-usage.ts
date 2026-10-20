// Wrapper uses and successful measured requests are separate units; never infer token savings.
export function openjevUsage(text: string | null, now=Date.now()) {
  const out = {asks:0,stateChars:0,byAgent:{} as Record<string,number>,available:text!==null,
    modelRequests:0, measuredRequests:0,inputTokens:0,outputTokens:0,elapsedMs:0};
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n>=0;
  for(const line of (text??'').split('\n')) {
    try {
      const r=JSON.parse(line), at=Date.parse(r.at);
      if(!Number.isFinite(at) || at<now-864e5 || at>now || r.outcome_for)continue;
      if(r.kind==='model_request') {
        out.modelRequests++;
        if(count(r.input_tokens) && count(r.output_tokens)) {
          out.measuredRequests++;out.inputTokens+=r.input_tokens;out.outputTokens+=r.output_tokens;
        }
        if(count(r.elapsed_ms))out.elapsedMs+=r.elapsed_ms;
      } else if(r.id) {
        out.asks++;if(count(r.state_chars))out.stateChars+=r.state_chars;
        const agent=['claude','cursor','codex','muse','kiro','grok'].includes(r.agent)?r.agent:'?';
        out.byAgent[agent]=(out.byAgent[agent]??0)+1;
      }
    } catch { /* incomplete or malformed log row */ }
  }
  return out;
}
