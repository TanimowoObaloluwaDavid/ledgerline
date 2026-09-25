import {
  type Account,
  type AccountInput,
  type AccountType,
  createAccount,
  SYSTEM_ACCOUNTS,
} from './account.js';
import {
  AccountAlreadyExistsError,
  AccountCycleError,
  AccountNotFoundError,
  AccountTypeConflictError,
  ValidationError,
} from './errors.js';

/**
 * An indexed, validated view over a set of accounts.
 *
 * The tree is rebuilt (never mutated in place) whenever accounts change, so
 * structural invariants — unique codes, resolvable parents, no cycles, matched
 * parent/child types — are checked once per change instead of at every posting.
 */
export class AccountTree {
  private readonly byCode: ReadonlyMap<string, Account>;
  private readonly childrenByCode: ReadonlyMap<string, readonly string[]>;
  private readonly depthByCode: ReadonlyMap<string, number>;

  constructor(accounts: readonly Account[]) {
    const byCode = new Map<string, Account>();
    for (const account of accounts) {
      if (byCode.has(account.code)) {
        throw new AccountAlreadyExistsError(account.code);
      }
      byCode.set(account.code, account);
    }

    const children = new Map<string, string[]>();
    for (const account of byCode.values()) {
      if (account.parentCode === null) {
        continue;
      }
      const parent = byCode.get(account.parentCode);
      if (parent === undefined) {
        throw new AccountNotFoundError(account.parentCode);
      }
      if (parent.type !== account.type) {
        throw new AccountTypeConflictError(account.code, parent.type, account.type);
      }
      const bucket = children.get(parent.code);
      if (bucket === undefined) {
        children.set(parent.code, [account.code]);
      } else {
        bucket.push(account.code);
      }
    }
    for (const [code, list] of children) {
      list.sort();
      children.set(code, list);
    }

    const depth = new Map<string, number>();
    for (const code of byCode.keys()) {
      depth.set(code, this.resolveDepth(code, byCode, children, new Set()));
    }

    this.byCode = byCode;
    this.childrenByCode = children;
    this.depthByCode = depth;
  }

  private resolveDepth(
    code: string,
    byCode: ReadonlyMap<string, Account>,
    children: ReadonlyMap<string, string[]>,
    seen: Set<string>,
  ): number {
    if (seen.has(code)) {
      throw new AccountCycleError(code);
    }
    const account = byCode.get(code);
    if (account === undefined) {
      throw new AccountNotFoundError(code);
    }
    if (account.parentCode === null) {
      return 0;
    }
    seen.add(code);
    const parentDepth = this.resolveDepth(account.parentCode, byCode, children, seen);
    seen.delete(code);
    if (parentDepth > 32) {
      throw new ValidationError('Account tree is deeper than 32 levels.', { code });
    }
    return parentDepth + 1;
  }

  get size(): number {
    return this.byCode.size;
  }

  all(): readonly Account[] {
    return [...this.byCode.values()];
  }

  has(code: string): boolean {
    return this.byCode.has(normalize(code));
  }

  get(code: string): Account {
    const account = this.byCode.get(normalize(code));
    if (account === undefined) {
      throw new AccountNotFoundError(code);
    }
    return account;
  }

  childrenOf(code: string): readonly Account[] {
    const codes = this.childrenByCode.get(normalize(code)) ?? [];
    return codes.map((child) => this.get(child));
  }

  /** Depth-first pre-order, siblings sorted by code: stable report ordering. */
  ordered(): readonly Account[] {
    const result: Account[] = [];
    const visit = (account: Account): void => {
      result.push(account);
      for (const child of this.childrenOf(account.code)) {
        visit(child);
      }
    };
    for (const account of this.roots()) {
      visit(account);
    }
    return result;
  }

  roots(): readonly Account[] {
    return this.all()
      .filter((account) => account.parentCode === null)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  ancestorsOf(code: string): readonly Account[] {
    const chain: Account[] = [];
    let current = this.get(code);
    while (current.parentCode !== null) {
      current = this.get(current.parentCode);
      chain.push(current);
    }
    return chain;
  }

  /** The account plus everything beneath it. */
  subtreeOf(code: string): readonly Account[] {
    const root = this.get(code);
    const collected: Account[] = [root];
    const stack = [root.code];
    while (stack.length > 0) {
      for (const child of this.childrenOf(stack.pop() as string)) {
        collected.push(child);
        stack.push(child.code);
      }
    }
    return collected;
  }

  isPostable(code: string): boolean {
    const account = this.get(code);
    return !account.computed && (this.childrenByCode.get(account.code)?.length ?? 0) === 0;
  }

  depthOf(code: string): number {
    return this.depthByCode.get(normalize(code)) ?? 0;
  }

  /** Ancestor codes from the root down to (but excluding) `code`. */
  pathOf(code: string): readonly string[] {
    return this.ancestorsOf(code)
      .map((account) => account.code)
      .reverse();
  }

  codesOfType(type: AccountType): readonly string[] {
    return this.all()
      .filter((account) => account.type === type)
      .map((account) => account.code)
      .sort();
  }
}

function normalize(code: string): string {
  return code.trim().toUpperCase();
}

/** The stock chart of accounts, ready to be persisted. */
export function systemChartOfAccounts(): Account[] {
  return SYSTEM_ACCOUNTS.map((input: AccountInput) => createAccount(input));
}
