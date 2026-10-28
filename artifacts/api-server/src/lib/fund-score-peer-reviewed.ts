import type { FundRowInput } from "./fund-score-types.js";

/** Key used in the reviewed set: ticker|groupId (groupId may be null → "ticker|null"). */
export function peerReviewedKey(ticker: string, groupId: string | null | undefined): string {
  return `${ticker}|${groupId ?? null}`;
}

/**
 * When peer-reference is on, set peerReviewed true/false from the reviewed key set.
 * When off, leave the flag unset (engine treats missing as in-norm).
 */
export function attachPeerReviewed(
  input: FundRowInput,
  peerReferenceOn: boolean,
  reviewed: Set<string>,
  ticker: string,
  groupId: string | null,
): FundRowInput {
  if (!peerReferenceOn) return input;
  return { ...input, peerReviewed: reviewed.has(peerReviewedKey(ticker, groupId)) };
}
