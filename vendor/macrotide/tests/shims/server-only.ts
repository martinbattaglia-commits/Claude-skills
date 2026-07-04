// Vitest runs in Node; the "server-only" package throws at import time in any
// non-server context. This shim no-ops the import so unit tests can exercise
// server-side modules directly.
export {};
