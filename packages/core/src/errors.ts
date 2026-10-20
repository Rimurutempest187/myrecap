export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Errors that should NOT be retried by the queue (bad input, insufficient credits, etc.) */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by user');
    this.name = 'JobCancelledError';
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);
export const paymentRequired = (msg: string, details?: unknown) => new AppError(402, 'INSUFFICIENT_CREDITS', msg, details);
export const tooMany = (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg);
