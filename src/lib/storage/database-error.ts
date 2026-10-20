export class DatabaseError extends Error {
  constructor(message = 'Database unavailable; no fallback was attempted.') { super(message); }
}
