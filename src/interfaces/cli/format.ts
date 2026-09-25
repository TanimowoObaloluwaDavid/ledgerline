import type { LedgerService } from '../../application/service.js';
import { LedgerError } from '../../domain/errors.js';
import type { Money } from '../../domain/money.js';
import type { ReportLine, StatementSection } from '../../domain/statements.js';

/**
 * Terminal formatting.
 *
 * Money is printed from its exact decimal string, never from a float, so a total
 * that balances to the cent in the engine also balances on screen. Columns are
 * padded with a plain monospace routine: a table renderer would be a dependency
 * with no other purpose.
 */

export function renderMoney(money: Money, width = 0): string {
  const text = money.toDecimalString();
  return width > 0 ? text.padStart(width) : text;
}

export function renderMoneyWithCode(money: Money, width = 0): string {
  const text = `${money.toDecimalString()} ${money.currency}`;
  return width > 0 ? text.padStart(width) : text;
}

/**
 * A section's first line is usually the roll-up that carries the section total
 * and the same name as the title. Printing both is noise, so drop it.
 */
export function bodyLines(section: StatementSection): readonly ReportLine[] {
  return section.lines.filter((line) => !(line.depth === 0 && line.name === section.title));
}

export function renderSection(section: StatementSection, indent = '  '): string {
  const lines = bodyLines(section);
  const width = Math.max(0, ...lines.map((line) => line.amount.toDecimalString().length));
  const totalWidth = Math.max(width, section.total.toDecimalString().length);
  return [
    section.title,
    ...lines.map((line) => renderLine(line, totalWidth, indent)),
    `${indent}${'Total'.padEnd(40)} ${renderMoney(section.total, totalWidth)}`,
  ].join('\n');
}

export function renderLine(line: ReportLine, width: number, indent: string): string {
  const label = line.isSubtotal ? `${line.name} (subtotal)` : line.name;
  return `${indent}${'  '.repeat(line.depth)}${label.padEnd(40 - line.depth * 2)} ${renderMoney(
    line.amount,
    width,
  )}`;
}

/** Human summary used by `ledgerline demo` and the README. */
export async function describeService(service: LedgerService): Promise<string> {
  const accounts = await service.accounts();
  const entries = await service.entries();
  const integrity = await service.verify();
  return [
    `accounts: ${accounts.length}`,
    `entries:  ${entries.length}`,
    `balanced: ${integrity.balanced ? 'yes' : 'no'}`,
  ].join('\n');
}

/** Prints a ledgerline error the way a CLI should: code first, then the message. */
export function formatError(error: unknown): string {
  if (error instanceof LedgerError) {
    const details =
      Object.keys(error.details).length === 0 ? '' : ` ${JSON.stringify(error.details)}`;
    return `${error.code}: ${error.message}${details}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
