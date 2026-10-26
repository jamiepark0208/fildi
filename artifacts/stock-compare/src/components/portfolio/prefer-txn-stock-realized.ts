/** A259: replace export stocksRealized with txn only when export is 0/missing or signs agree + |txn| larger. */
export function preferTxnStockRealized(exportVal: number, txnVal: number): { value: number; mixed: boolean } {
  if (exportVal === 0) return { value: txnVal, mixed: false };
  if (Math.abs(txnVal) <= Math.abs(exportVal) + 0.01) return { value: exportVal, mixed: false };
  const sameSign = Math.sign(exportVal) === Math.sign(txnVal);
  if (sameSign) return { value: txnVal, mixed: false };
  return { value: exportVal, mixed: true };
}
