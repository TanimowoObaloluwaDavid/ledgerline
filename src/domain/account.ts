import { assertCurrency, type CurrencyCode } from './currency.js';
import { ValidationError } from './errors.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Side = 'debit' | 'credit';

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9:._-]{0,31}$/;

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentCode: string | null;
  /** Currency the account is denominated in; `null` means any currency. */
  readonly currency: CurrencyCode | null;
  readonly description: string;
  readonly tags: readonly string[];
  /**
   * Computed accounts (retained earnings, current-year results) are derived by
   * the engine and reject hand-written postings, so reports stay consistent.
   */
  readonly computed: boolean;
  readonly system: boolean;
  readonly createdAt: string;
}

export interface AccountInput {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentCode?: string | null;
  readonly currency?: CurrencyCode | null;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly computed?: boolean;
  readonly system?: boolean;
  readonly createdAt?: string;
}

/** Which side increases an account of this type. */
export function normalSide(type: AccountType): Side {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** `+1` for debit-normal accounts, `-1` for credit-normal ones. */
export function signMultiplier(type: AccountType): 1 | -1 {
  return normalSide(type) === 'debit' ? 1 : -1;
}

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

export function assertAccountType(value: string): AccountType {
  if (!isAccountType(value)) {
    throw new ValidationError(
      `Unknown account type '${value}'. Expected one of: ${ACCOUNT_TYPES.join(', ')}.`,
      { type: value },
    );
  }
  return value;
}

/** Accounts that close into retained earnings at period end. */
export function isTemporary(type: AccountType): boolean {
  return type === 'income' || type === 'expense';
}

export function createAccount(input: AccountInput): Account {
  const code = normalizeCode(input.code, 'Account code');
  const name = input.name.trim();
  if (name === '' || name.length > 120) {
    throw new ValidationError('Account name must be 1-120 characters.', { code, name });
  }
  const type = assertAccountType(input.type);
  const parentCode = normalizeParent(input.parentCode, code);
  const currency =
    input.currency === null || input.currency === undefined ? null : assertCurrency(input.currency);
  const tags = normalizeTags(input.tags, code);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new ValidationError('createdAt must be an ISO-8601 timestamp.', { code, createdAt });
  }
  if (type === 'income' && currency === null && input.computed === true) {
    throw new ValidationError('Computed accounts must be denominated in a currency.', { code });
  }

  return Object.freeze({
    code,
    name,
    type,
    parentCode,
    currency,
    description: (input.description ?? '').trim(),
    tags: Object.freeze(tags),
    computed: input.computed ?? false,
    system: input.system ?? false,
    createdAt,
  });
}

function normalizeCode(raw: string, label: string): string {
  const code = raw.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError(
      `${label} '${raw}' must be 1-32 characters of A-Z, 0-9, ':', '.', '_' or '-'.`,
      { code: raw },
    );
  }
  return code;
}

function normalizeParent(raw: string | null | undefined, code: string): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return null;
  }
  const parentCode = raw.trim().toUpperCase();
  if (parentCode === code) {
    throw new ValidationError(`Account '${code}' cannot be its own parent.`, { code });
  }
  return normalizeCode(parentCode, 'Parent code');
}

function normalizeTags(raw: readonly string[] | undefined, code: string): string[] {
  const tags = [...new Set((raw ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''))];
  if (tags.length > 16) {
    throw new ValidationError('An account may carry at most 16 tags.', { code });
  }
  return tags;
}

/** Structural copy with a patched parent, used when re-parenting. */
export function reparent(account: Account, parentCode: string | null): Account {
  return createAccount({
    code: account.code,
    name: account.name,
    type: account.type,
    parentCode,
    currency: account.currency,
    description: account.description,
    tags: account.tags,
    computed: account.computed,
    system: account.system,
    createdAt: account.createdAt,
  });
}

/** A minimal, standards-shaped chart of accounts. */
export const SYSTEM_ACCOUNTS: readonly AccountInput[] = Object.freeze([
  { code: '1000', name: 'Assets', type: 'asset', system: true },
  { code: '1100', name: 'Cash', type: 'asset', parentCode: '1000', system: true },
  { code: '1110', name: 'Bank', type: 'asset', parentCode: '1000', system: true },
  { code: '1200', name: 'Accounts Receivable', type: 'asset', parentCode: '1000', system: true },
  { code: '1300', name: 'Inventory', type: 'asset', parentCode: '1000', system: true },
  { code: '1500', name: 'Fixed Assets', type: 'asset', parentCode: '1000', system: true },
  { code: '2000', name: 'Liabilities', type: 'liability', system: true },
  { code: '2100', name: 'Accounts Payable', type: 'liability', parentCode: '2000', system: true },
  { code: '2200', name: 'Credit Card', type: 'liability', parentCode: '2000', system: true },
  { code: '2300', name: 'Loans Payable', type: 'liability', parentCode: '2000', system: true },
  { code: '3000', name: 'Equity', type: 'equity', system: true },
  { code: '3100', name: 'Owner Capital', type: 'equity', parentCode: '3000', system: true },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'equity',
    parentCode: '3000',
    currency: 'USD',
    computed: true,
    system: true,
    description: 'Closed automatically from income and expense accounts.',
  },
  {
    code: '3210',
    name: 'FX Translation Clearing',
    type: 'equity',
    parentCode: '3000',
    computed: true,
    system: true,
    description:
      'Bridge used when a foreign-currency period is closed into a different ' +
      'functional currency. Should hold a zero balance once closing completes.',
  },
  { code: '4000', name: 'Revenue', type: 'income', system: true },
  { code: '4100', name: 'Sales', type: 'income', parentCode: '4000', system: true },
  { code: '4200', name: 'Other Income', type: 'income', parentCode: '4000', system: true },
  { code: '5000', name: 'Expenses', type: 'expense', system: true },
  { code: '5100', name: 'Cost of Goods Sold', type: 'expense', parentCode: '5000', system: true },
  { code: '5200', name: 'Rent', type: 'expense', parentCode: '5000', system: true },
  { code: '5300', name: 'Utilities', type: 'expense', parentCode: '5000', system: true },
  { code: '5400', name: 'Payroll', type: 'expense', parentCode: '5000', system: true },
  { code: '5500', name: 'Marketing', type: 'expense', parentCode: '5000', system: true },
  { code: '5600', name: 'Bank Fees', type: 'expense', parentCode: '5000', system: true },
]);
