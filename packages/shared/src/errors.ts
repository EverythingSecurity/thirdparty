/**
 * Standard API error envelope (blueprint §4).
 *
 *   { "error": { "code": "string", "message": "string", "fields": { ... } } }
 *
 * `AppError` subclasses map cleanly to HTTP status codes in the API error
 * middleware. Do NOT leak stack traces or ORM error strings to clients —
 * `message` is the safe, user-facing description.
 */

export type ErrorFields = Record<string, string>;

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields?: ErrorFields;
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields: ErrorFields | undefined;

  constructor(statusCode: number, code: string, message: string, fields?: ErrorFields) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fields?: ErrorFields) {
    super(400, 'validation_error', message, fields);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthenticated', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not authorized for this resource') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

/** 410 — used for expired/revoked vendor invite tokens (blueprint §4 `/vendor/session`). */
export class GoneError extends AppError {
  constructor(code: string, message: string) {
    super(410, code, message);
  }
}

export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, fields?: ErrorFields) {
    super(422, code, message, fields);
  }
}
