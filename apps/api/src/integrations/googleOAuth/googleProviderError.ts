export class GoogleProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); }
}
