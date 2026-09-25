/**
 * Error taxonomy for the domain layer.
 *
 * Every failure the engine can produce is a {@link LedgerError} carrying a stable
 * machine-readable `code`. The HTTP and CLI layers map codes to transports without
 * ever inspecting messages, so codes are part of the public API.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'ACCOUNT_NOT_POSTABLE'
  | 'ACCOUNT_TYPE_CONFLICT'
  | 'ACCOUNT_CYCLE'
  | 'CURRENCY_MISMATCH'
  | 'CURRENCY_UNSUPPORTED'
  | 'UNBALANCED_ENTRY'
  | 'EMPTY_ENTRY'
  | 'NON_POSITIVE_AMOUNT'
  | 'DUPLICATE_ACCOUNT_IN_ENTRY'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_ALREADY_REVERSED'
  | 'RATE_NOT_FOUND'
  | 'INVALID_RATE'
  | 'INVALID_RECURRENCE'
  | 'CONFLICT'
  | 'INTERNAL';

export interface LedgerErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** Base class for every error raised by the engine. */
export class LedgerError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: LedgerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

/** Input that is structurally or semantically invalid. */
export class ValidationError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('VALIDATION_FAILED', message, details === undefined ? {} : { details });
  }
}

export class AccountNotFoundError extends LedgerError {
  constructor(code: string) {
    super('ACCOUNT_NOT_FOUND', `No account with code '${code}'.`, { details: { code } });
  }
}

export class AccountAlreadyExistsError extends LedgerError {
  constructor(code: string) {
    super('ACCOUNT_ALREADY_EXISTS', `Account '${code}' already exists.`, { details: { code } });
  }
}

export class AccountNotPostableError extends LedgerError {
  constructor(code: string) {
    super('ACCOUNT_NOT_POSTABLE', `Account '${code}' has children and cannot receive postings.`, {
      details: { code },
    });
  }
}

export class AccountTypeConflictError extends LedgerError {
  constructor(code: string, expected: string, actual: string) {
    super(
      'ACCOUNT_TYPE_CONFLICT',
      `Account '${code}' is of type '${actual}' where '${expected}' was required.`,
      { details: { code, expected, actual } },
    );
  }
}

export class AccountCycleError extends LedgerError {
  constructor(code: string) {
    super('ACCOUNT_CYCLE', `Re-parenting '${code}' would create a cycle in the account tree.`, {
      details: { code },
    });
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `Cannot combine ${left} with ${right} in a single expression.`, {
      details: { left, right },
    });
  }
}

export class CurrencyUnsupportedError extends LedgerError {
  constructor(currency: string) {
    super('CURRENCY_UNSUPPORTED', `Currency '${currency}' is not supported.`, {
      details: { currency },
    });
  }
}

export class UnbalancedEntryError extends LedgerError {
  constructor(debits: bigint, credits: bigint, currency: string) {
    super(
      'UNBALANCED_ENTRY',
      `Entry does not balance: debits ${debits} vs credits ${credits} (${currency}).`,
      { details: { debits: debits.toString(), credits: credits.toString(), currency } },
    );
  }
}

export class EmptyEntryError extends LedgerError {
  constructor(reason: string) {
    super('EMPTY_ENTRY', `Entry has no effect: ${reason}.`, { details: { reason } });
  }
}

export class NonPositiveAmountError extends LedgerError {
  constructor(value: string, currency: string) {
    super('NON_POSITIVE_AMOUNT', `Amount must be greater than zero, received ${value}.`, {
      details: { value, currency },
    });
  }
}

export class DuplicateAccountInEntryError extends LedgerError {
  constructor(code: string) {
    super(
      'DUPLICATE_ACCOUNT_IN_ENTRY',
      `Account '${code}' appears twice on the same side of the entry.`,
      { details: { code } },
    );
  }
}

export class EntryNotFoundError extends LedgerError {
  constructor(id: string) {
    super('ENTRY_NOT_FOUND', `No journal entry with id '${id}'.`, { details: { id } });
  }
}

export class EntryAlreadyReversedError extends LedgerError {
  constructor(id: string, reversalId: string) {
    super('ENTRY_ALREADY_REVERSED', `Entry '${id}' was already reversed by '${reversalId}'.`, {
      details: { id, reversalId },
    });
  }
}

export class RateNotFoundError extends LedgerError {
  constructor(from: string, to: string, date: string) {
    super('RATE_NOT_FOUND', `No exchange rate for ${from}/${to} on ${date}.`, {
      details: { from, to, date },
    });
  }
}

export class InvalidRateError extends LedgerError {
  constructor(reason: string) {
    super('INVALID_RATE', `Invalid exchange rate: ${reason}.`, { details: { reason } });
  }
}

export class InvalidRecurrenceError extends LedgerError {
  constructor(reason: string) {
    super('INVALID_RECURRENCE', `Invalid recurrence rule: ${reason}.`, { details: { reason } });
  }
}

export class ConflictError extends LedgerError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('CONFLICT', message, details === undefined ? {} : { details });
  }
}
