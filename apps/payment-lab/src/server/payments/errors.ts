/** Typed lab store errors. Routes map these to HTTP; the store never sends HTTP. */

export class LabValidationError extends Error {
  readonly code = "LAB_VALIDATION" as const;
  readonly statusCode = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "LabValidationError";
  }
}

export class LabNotFoundError extends Error {
  readonly code = "LAB_NOT_FOUND" as const;
  readonly statusCode = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = "LabNotFoundError";
  }
}

export class LabConflictError extends Error {
  readonly code = "LAB_CONFLICT" as const;
  readonly statusCode = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "LabConflictError";
  }
}

export function isLabConflict(error: unknown): error is LabConflictError {
  return error instanceof LabConflictError;
}

export function isLabNotFound(error: unknown): error is LabNotFoundError {
  return error instanceof LabNotFoundError;
}

export function isLabValidation(error: unknown): error is LabValidationError {
  return error instanceof LabValidationError;
}
