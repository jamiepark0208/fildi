// Moved to the shared workspace package so api-server's weekly model snapshot
// runs the exact same scorer as the UI. Re-export shim — do not add logic here.
export * from "@workspace/option-scoring";
