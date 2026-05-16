/**
 * Standardized error codes used across the Keke backend.
 * Flutter clients map these codes to user-friendly copy.
 */
export const ErrorCode = {
  // Auth
  VALIDATION_ERROR:          'VALIDATION_ERROR',
  MISSING_FIELDS:            'MISSING_FIELDS',
  INVALID_EMAIL:             'INVALID_EMAIL',
  WEAK_PASSWORD:             'WEAK_PASSWORD',
  EMAIL_ALREADY_REGISTERED:  'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS:       'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED:        'EMAIL_NOT_VERIFIED',
  INVALID_OTP:               'INVALID_OTP',
  RATE_LIMITED:              'RATE_LIMITED',
  USER_NOT_FOUND:            'USER_NOT_FOUND',
  SESSION_EXPIRED:           'SESSION_EXPIRED',
  FORBIDDEN:                 'FORBIDDEN',

  // Driver / KYC
  PROFILE_NOT_FOUND:         'PROFILE_NOT_FOUND',
  UPLOAD_FAILED:             'UPLOAD_FAILED',
  DRIVER_SUSPENDED:          'DRIVER_SUSPENDED',
  DEBT_CASH_BLOCKED:         'DEBT_CASH_BLOCKED',

  // Finance
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET_BALANCE',
  PAYMENT_FAILED:            'PAYMENT_FAILED',

  // Rides
  RIDE_NOT_FOUND:            'RIDE_NOT_FOUND',
  RIDE_ALREADY_TAKEN:        'RIDE_ALREADY_TAKEN',

  // Generic
  INTERNAL_ERROR:            'INTERNAL_ERROR',
  NOT_FOUND:                 'NOT_FOUND',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

/** Structured error shape sent to all clients. */
export interface AppErrorBody {
  code: ErrorCodeType;
  message: string;
}

/**
 * Throw this inside route handlers when you want a specific
 * status code + code to reach the client.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCodeType,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Build a safe { code, message } response body. Never leaks raw DB text. */
export function errBody(code: ErrorCodeType, message: string): AppErrorBody {
  return { code, message };
}
