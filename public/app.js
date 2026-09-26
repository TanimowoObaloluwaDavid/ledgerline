/**
 * Ledgerline web app.
 *
 * A single page over the REST API, written as plain ES modules: no bundler, no
 * framework, nothing to install. Each view is a function that returns a DOM
 * fragment, and the router swaps fragments in and out. The whole app is one
 * folder of readable files, which is the point — a book you cannot read is a
 * book you cannot trust.
 */

import { api } from './lib/api.js';
import { clear, clearError, h, showError, Table } from './lib/dom.js';
import {
  balanceOf,
  formatMinor,
  formatMoney,
  isNegative,
  isZero,
  magnitude,
  parseAmount,
  sumMoney,
} from './lib/money.js';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const EM_DASH = '\u2014';
const DOT = ' \u00b7 ';
const ARROW = ' \u2192 ';
const TIMES = '\u00d7';
const DELTA = '\u0394';

const view = document.querySelector('#view');
const toast = document.querySelector('#toast');
const bookMeta = document.querySelector('#book-meta');
const verifyChip = document.querySelector('#verify-chip');
const dialog = document.querySelector('#dialog');
const dialogForm = document.querySelector('#dialog-form');
const dialogBody = document.querySelector('#dialog-body');
const dialogTitle = document.querySelector('#dialog-title');

/** Loaded once per page: the chart of accounts, closed periods, integrity. */
const book = { accounts: [], periods: [], integrity: null, currency: 'USD', exponent: 2 };

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (date) => `${date.toISOString().slice(0, 7)}-01`;

/** Shared period filter, so every report agrees on the dates it covers. */
const period = { from: monthStart(new Date()), to: today() };
let periodPinned = false;

/* ------------------------------------------------------------------ shell */

const VIEWS = {
  dashboard: dashboardView,
  entry: entryView,
  journal: journalView,
  accounts: accountsView,
  reports: reportsView,
  rates: ratesView,
  close: closeView,
};

const params = new URLSearchParams(location.hash.slice(1));

const currentRoute = () => {
  const name = params.get('view') ?? 'dashboard';
  return VIEWS[name] ? name : 'dashboard';
};

function navigate(name) {
  params.set('view', name);
  location.hash = params.toString();
}

let firstRender = true;

async function render() {
  const name = currentRoute();
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === name) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
  clear(view);
  try {
    view.append(await VIEWS[name]());
    // Move focus into the new content so a screen reader announces the change.
    // Not on the first load: that would put a keyboard user's cursor halfway
    // down the page before they had done anything.
    if (!firstRender) {
      view.focus();
    }
    firstRender = false;
  } catch (error) {
    clear(view);
    view.append(card(h('h1', { text: 'Something went wrong' }), errorBox(error)));
  }
}

function flash(message, bad = false) {
  toast.textContent = message;
  toast.className = bad ? 'toast toast--bad' : 'toast';
  toast.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

function errorBox(error) {
  const box = h('div', { class: 'notice' });
  showError(box, error);
  return box;
}

/** A moment of confirmation before anything that writes to the book. */
function confirmAsk(title, question) {
  dialogTitle.textContent = title;
  dialogBody.textContent = question;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    });
    dialog.showModal();
  });
}

/* ----------------------------------------------------------------- pieces */

function moneyCell(money, { zero = EM_DASH } = {}) {
  if (isZero(money)) {
    return zero;
  }
  return h(
    'span',
    { class: isNegative(money) ? 'neg' : undefined },
    `${money.decimal} ${money.currency}`,
  );
}
function lineName(line) {
  return h(
    'span',
    { class: line.isSubtotal ? undefined : `indent-${line.depth}` },
    line.isSubtotal ? `${line.name} (total)` : line.name,
  );
}

function sectionTable(section, { asObligation = false } = {}) {
  return new Table({
    caption: section.title,
    columns: [
      { key: 'name', label: 'Account' },
      { key: 'amount', label: 'Amount', numeric: true },
    ],
    rows: section.lines.map((line) => ({
      isSubtotal: line.isSubtotal,
      name: lineName(line),
      amount: moneyCell(asObligation ? magnitude(line.amount) : line.amount),
    })),
    rowClass: (row) => (row.isSubtotal ? 'subtotal' : undefined),
    empty: 'Nothing in this section.',
  }).render();
}

/**
 * The amount string the API expects: `1234.56 USD`.
 *
 * The engine insists on an explicit currency rather than assuming one, which is
 * the right call for a ledger. It also means the form has to add it, using the
 * account's own currency when it has one, because a posting to a foreign
 * account is not in the book's currency no matter what the operator typed.
 */
function composeAmount(accountCode, text) {
  const account = book.accounts.find((candidate) => candidate.code === accountCode);
  return `${text.trim()} ${account?.currency ?? book.currency}`;
}

function pageHead(title, lede, ...actions) {
  return h(
    'div',
    { class: 'card__head' },
    h('div', null, h('h1', { text: title }), lede ? h('p', { class: 'lede', text: lede }) : null),
    actions.length > 0 ? h('div', { class: 'actions' }, ...actions) : null,
  );
}

function card(...children) {
  return h('section', { class: 'card' }, ...children);
}

function stat(label, value, note, tone = '') {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat__label', text: label }),
    h('span', { class: `stat__value ${tone}`.trim(), text: value }),
    note ? h('span', { class: 'stat__note', text: note }) : null,
  );
}

function periodPicker(onChange) {
  const from = h('input', { id: 'period-from', type: 'date', value: period.from, max: period.to });
  const to = h('input', { id: 'period-to', type: 'date', value: period.to, min: period.from });
  const apply = (key) => (event) => {
    period[key] = event.target.value;
    onChange();
  };
  from.addEventListener('change', apply('from'));
  to.addEventListener('change', apply('to'));
  return h(
    'div',
    { class: 'form-row' },
    h('div', { class: 'field' }, h('label', { for: 'period-from', text: 'From' }), from),
    h('div', { class: 'field' }, h('label', { for: 'period-to', text: 'To' }), to),
  );
}

function accountOptions(selected) {
  return book.accounts
    .filter((account) => !account.computed)
    .map((account) =>
      h(
        'option',
        { value: account.code, selected: account.code === selected || undefined },
        `${account.code}${DOT}${account.name}`,
      ),
    );
}

function postingTable(entry) {
  return new Table({
    caption: `Postings for entry ${entry.sequence}`,
    columns: [
      { key: 'account', label: 'Account' },
      { key: 'side', label: 'Dr/Cr' },
      { key: 'amount', label: 'Amount', numeric: true },
      { key: 'memo', label: 'Note' },
    ],
    rows: entry.postings.map((posting) => ({
      account: h('span', { class: 'code', text: posting.accountCode }),
      side: posting.side === 'debit' ? 'Dr' : 'Cr',
      amount: `${posting.amount.decimal} ${posting.amount.currency}`,
      memo: posting.memo ?? EM_DASH,
    })),
  }).render();
}

function entryList(entries, { limit } = {}) {
  if (entries.length === 0) {
    return h('p', { class: 'empty', text: 'No entries in this range yet.' });
  }
  const shown = limit === undefined ? entries : entries.slice(0, limit);
  return h(
    'div',
    null,
    ...shown.map((entry) => {
      const postings = h('div', { class: 'entry__postings', hidden: true }, postingTable(entry));
      const toggle = h('button', { class: 'entry__toggle', type: 'button' }, 'Show postings');
      toggle.addEventListener('click', () => {
        postings.hidden = !postings.hidden;
        toggle.textContent = postings.hidden ? 'Show postings' : 'Hide postings';
      });
      return h(
        'article',
        { class: 'entry' },
        h(
          'div',
          { class: 'entry__head' },
          h(
            'div',
            null,
            h('div', { class: 'entry__memo', text: entry.memo ?? '(no memo)' }),
            h(
              'div',
              { class: 'entry__meta' },
              `#${entry.sequence}${DOT}${entry.date}${
                entry.reference ? `${DOT}ref ${entry.reference}` : ''
              }`,
            ),
          ),
          h('div', { class: 'actions' }, toggle, reverseButton(entry)),
        ),
        postings,
      );
    }),
  );
}

function reverseButton(entry) {
  const total = sumMoney(
    entry.postings.filter((posting) => posting.side === 'debit').map((posting) => posting.amount),
  );
  const button = h('button', { class: 'button button--danger', type: 'button' }, 'Reverse');
  button.addEventListener('click', async () => {
    const ok = await confirmAsk(
      'Reverse this entry?',
      `A new entry dated today will mirror the ${entry.postings.length} postings of #${entry.sequence} ` +
        `(${formatMoney(total)}). The original stays in the journal, because a ledger that erases ` +
        'history is not a ledger.',
    );
    if (!ok) {
      return;
    }
    try {
      await api.reverseEntry(entry.id, { date: today() });
      flash(`Reversed entry #${entry.sequence}.`);
      await refresh();
      await render();
    } catch (error) {
      flash(`${error.code ?? 'Error'}: ${error.message}`, true);
    }
  });
  return button;
}

/**
 * A three-bar comparison, drawn as SVG so the geometry lives in attributes
 * rather than inline styles.
 *
 * @param {readonly { label: string, amount: { minor: string }, negative?: boolean }[]} bars
 */
function barChart(bars) {
  const width = 300;
  const height = 112;
  const gap = 24;
  const barWidth = (width - gap * (bars.length + 1)) / bars.length;
  const sizeOf = (amount) => BigInt(amount.minor.replace('-', ''));
  const peak = bars.reduce((widest, bar) => {
    const size = sizeOf(bar.amount);
    return size > widest ? size : widest;
  }, 0n);
  const usable = height - 22;

  return h(
    'svg',
    {
      class: 'chart',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': bars.map((bar) => `${bar.label} ${bar.amount.minor}`).join(', '),
    },
    ...bars.map((bar, index) => {
      const size = sizeOf(bar.amount);
      const barHeight =
        peak === 0n ? 2 : Math.max(2, Math.round((Number(size) / Number(peak)) * usable));
      const x = gap + index * (barWidth + gap);
      return h(
        'g',
        null,
        h('rect', {
          x: String(x),
          y: String(height - 20 - barHeight),
          width: String(barWidth),
          height: String(barHeight),
          rx: '4',
          class: bar.negative ? 'bar bar--neg' : 'bar',
        }),
        h(
          'text',
          {
            x: String(x + barWidth / 2),
            y: String(height - 4),
            'text-anchor': 'middle',
            class: 'chart__label',
          },
          bar.label,
        ),
      );
    }),
  );
}

/* --------------------------------------------------------------- dashboard */

async function dashboardView() {
  const [sheet, income, entries] = await Promise.all([
    api.balanceSheet(period.to),
    api.incomeStatement(period.from, period.to),
    api.entries(period.from, period.to),
  ]);
  const report = sheet.report;
  const net = income.report.netIncome;

  return h(
    'div',
    null,
    pageHead(
      'Dashboard',
      `What the book says for ${period.from} to ${period.to}.`,
      h(
        'button',
        { class: 'button', type: 'button', onclick: () => navigate('entry') },
        'Post an entry',
      ),
    ),
    card(periodPicker(() => render())),
    h(
      'div',
      { class: 'grid grid--stats' },
      stat('Total assets', formatMoney(report.totalAssets), `as of ${report.asOf}`),
      stat('Liabilities', formatMoney(magnitude(report.liabilities.total)), 'what you owe'),
      stat('Equity', formatMoney(report.equity.total), 'capital and retained'),
      stat(
        'Net income',
        formatMoney(net),
        `${period.from} to ${period.to}`,
        isNegative(net) ? 'neg' : 'pos',
      ),
      stat('Current earnings', formatMoney(report.currentEarnings), 'not yet closed'),
      stat('Entries', String(entries.entries.length), 'in this date range'),
    ),
    h(
      'div',
      { class: 'grid grid--two' },
      card(
        h('h2', { text: 'Income against expenses' }),
        barChart([
          { label: 'Revenue', amount: income.report.totalRevenue },
          { label: 'Expenses', amount: income.report.totalExpenses, negative: true },
          { label: 'Net', amount: net, negative: isNegative(net) },
        ]),
        h(
          'p',
          { class: 'entry__meta' },
          `Revenue ${formatMoney(income.report.totalRevenue)}${DOT}Expenses ${formatMoney(
            income.report.totalExpenses,
          )}`,
        ),
      ),
      card(
        h('h2', { text: 'Integrity' }),
        h(
          'p',
          { class: 'entry__meta' },
          `${book.integrity.entries} entries checked against ${book.integrity.accounts} accounts.`,
        ),
        book.integrity.balanced
          ? h('p', { class: 'chip chip--ok', text: 'Journal balances' })
          : h('p', { class: 'chip chip--bad', text: 'Journal does not balance' }),
        book.integrity.problems.length > 0
          ? h(
              'ul',
              { class: 'notice' },
              ...book.integrity.problems.map((problem) => h('li', { text: String(problem) })),
            )
          : null,
      ),
    ),
    card(
      h('h2', { text: 'Latest entries' }),
      entryList(entries.entries, { limit: 6 }),
      entries.entries.length > 6
        ? h(
            'div',
            { class: 'actions' },
            h(
              'button',
              { class: 'button button--ghost', type: 'button', onclick: () => navigate('journal') },
              'Open the journal',
            ),
          )
        : null,
    ),
  );
}

/* -------------------------------------------------------------- new entry */

async function entryView() {
  const notice = h('div', { class: 'notice', hidden: true });
  const balance = h('div', { class: 'balance' });
  const rows = h('div', { class: 'postings' });
  const memo = h('input', {
    id: 'entry-memo',
    type: 'text',
    maxlength: '280',
    placeholder: 'What happened?',
  });
  const reference = h('input', {
    id: 'entry-ref',
    type: 'text',
    maxlength: '64',
    placeholder: 'INV-2025-014',
  });
  const date = h('input', { id: 'entry-date', type: 'date', value: today(), required: true });
  const submit = h('button', { class: 'button button--primary', type: 'submit' }, 'Post entry');
  const blankRow = (side = 'debit') => ({ accountCode: '', side, amount: '', memo: undefined });
  // Almost every entry is one debit and one credit, so the second line starts
  // on the other side. The balance indicator still guards it; this just saves
  // the click for the common case.
  const state = {
    idempotencyKey: crypto.randomUUID(),
    draft: [blankRow('debit'), blankRow('credit')],
  };

  function draw() {
    clear(rows);
    state.draft.forEach((row, index) => {
      const select = h(
        'select',
        null,
        h('option', { value: '' }, 'Choose an account'),
        ...accountOptions(row.accountCode),
      );
      const side = h(
        'select',
        null,
        ...['debit', 'credit'].map((value) =>
          h(
            'option',
            { value, selected: value === row.side || undefined },
            value === 'debit' ? 'Debit (Dr)' : 'Credit (Cr)',
          ),
        ),
      );
      const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00' });
      const note = h('input', { type: 'text', maxlength: '280', placeholder: 'Line note' });
      const remove = h(
        'button',
        { class: 'posting__remove', type: 'button', title: 'Remove this line' },
        TIMES,
      );
      amount.value = row.amount;
      note.value = row.memo ?? '';

      const sync = () => {
        state.draft[index] = {
          accountCode: select.value,
          side: side.value,
          amount: amount.value,
          memo: note.value === '' ? undefined : note.value,
        };
        refreshBalance();
      };
      for (const element of [select, side, amount, note]) {
        element.addEventListener('input', sync);
        element.addEventListener('change', sync);
      }
      remove.addEventListener('click', () => {
        if (state.draft.length <= 2) {
          flash('An entry needs at least two lines.', true);
          return;
        }
        state.draft.splice(index, 1);
        draw();
      });

      rows.appendChild(
        h(
          'div',
          { class: 'posting' },
          h('div', { class: 'field' }, h('label', { text: 'Account' }), select),
          h('div', { class: 'field' }, h('label', { text: 'Side' }), side),
          h('div', { class: 'field' }, h('label', { text: 'Amount' }), amount),
          h('div', { class: 'field' }, h('label', { text: 'Line note' }), note),
          remove,
        ),
      );
    });
    refreshBalance();
  }

  function refreshBalance() {
    const filled = state.draft.filter(
      (row) => row.accountCode !== '' && parseAmount(row.amount) !== null,
    );
    const { ok, text, debits, credits, difference } = balanceOf(filled);
    balance.className = `balance ${ok ? 'balance--ok' : 'balance--off'}`;
    clear(balance);
    balance.append(
      h('span', { class: 'balance__state', text }),
      h(
        'span',
        { class: 'balance__figures' },
        h('span', { text: `Dr ${formatMinor(debits, book.exponent)}` }),
        h('span', { text: `Cr ${formatMinor(credits, book.exponent)}` }),
        h('span', { text: `${DELTA} ${formatMinor(difference, book.exponent)}` }),
      ),
    );
    submit.disabled = !ok;
  }

  const addRow = h('button', { class: 'button', type: 'button' }, '+ Add line');
  addRow.addEventListener('click', () => {
    state.draft.push(blankRow('credit'));
    draw();
  });

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        clearError(notice);
        const postings = state.draft.filter(
          (row) => row.accountCode !== '' && row.amount.trim() !== '',
        );
        submit.disabled = true;
        try {
          const result = await api.postEntry(
            {
              date: date.value,
              ...(memo.value.trim() === '' ? {} : { memo: memo.value.trim() }),
              ...(reference.value.trim() === '' ? {} : { reference: reference.value.trim() }),
              postings: postings.map((row) => ({
                account: row.accountCode,
                side: row.side,
                amount: composeAmount(row.accountCode, row.amount),
                ...(row.memo === undefined ? {} : { memo: row.memo }),
              })),
            },
            state.idempotencyKey,
          );
          state.idempotencyKey = crypto.randomUUID();
          memo.value = '';
          reference.value = '';
          date.value = today();
          state.draft = [blankRow('debit'), blankRow('credit')];
          draw();
          notice.className = 'notice notice--ok';
          clear(notice);
          notice.hidden = false;
          notice.append(
            h(
              'p',
              { class: 'notice__title' },
              `Entry #${result.entry.sequence} is in the journal.`,
            ),
          );
          flash(`Posted entry #${result.entry.sequence}.`);
          await refresh();
        } catch (error) {
          notice.className = 'notice';
          showError(notice, error);
        } finally {
          refreshBalance();
        }
      },
    },
    h('h2', { text: 'Post an entry' }),
    h(
      'p',
      { class: 'lede' },
      'Two or more lines that must balance: what leaves one account arrives in another.',
    ),
    h(
      'div',
      { class: 'form-row' },
      h('div', { class: 'field' }, h('label', { for: 'entry-date', text: 'Date' }), date),
      h('div', { class: 'field' }, h('label', { for: 'entry-memo', text: 'Memo' }), memo),
      h('div', { class: 'field' }, h('label', { for: 'entry-ref', text: 'Reference' }), reference),
    ),
    h(
      'fieldset',
      null,
      h('legend', { text: 'Lines' }),
      rows,
      h('div', { class: 'actions' }, addRow),
    ),
    balance,
    notice,
    h('div', { class: 'actions' }, submit),
  );

  draw();
  return form;
}

/* ---------------------------------------------------------------- journal */

async function journalView() {
  const list = h('div', null, h('p', { class: 'loading', text: 'Reading the journal' }));
  const reference = h('input', { type: 'text', maxlength: '64', placeholder: 'All references' });

  const load = async () => {
    clear(list);
    list.append(h('p', { class: 'loading', text: 'Reading the journal' }));
    const { entries } = await api.entries(
      period.from,
      period.to,
      reference.value.trim() || undefined,
    );
    clear(list);
    list.append(entryList(entries));
  };

  reference.addEventListener('change', () => {
    load().catch((error) => flash(error.message, true));
  });
  await load();

  return h(
    'div',
    null,
    pageHead(
      'Journal',
      'Every entry, exactly as it was recorded. Nothing here is ever edited or deleted.',
    ),
    card(
      periodPicker(() => load()),
      h('div', { class: 'field' }, h('label', { text: 'Reference' }), reference),
    ),
    card(list),
  );
}

/* --------------------------------------------------------------- accounts */

async function accountsView() {
  const [accounts, trial] = await Promise.all([api.accounts(), api.trialBalance(period.to)]);
  const balances = new Map(
    trial.report.rows
      .filter((row) => row.isSubtotal === false)
      .map((row) => [row.code, row.amount]),
  );
  const search = h('input', { type: 'search', placeholder: 'Search code or name' });
  const typeFilter = h(
    'select',
    null,
    h('option', { value: '' }, 'All types'),
    ...ACCOUNT_TYPES.map((type) => h('option', { value: type }, type)),
  );
  const body = h('div');

  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const type = typeFilter.value;
    const rows = accounts.accounts
      .filter((account) => type === '' || account.type === type)
      .filter(
        (account) =>
          term === '' ||
          account.code.toLowerCase().includes(term) ||
          account.name.toLowerCase().includes(term),
      )
      .map((account) => ({
        code: h('span', { class: 'code', text: account.code }),
        name: account.name,
        type: h('span', { class: `tag tag--${account.type}`, text: account.type }),
        balance: moneyCell(balances.get(account.code), { zero: `0.00 ${book.currency}` }),
        flags: account.computed ? h('span', { class: 'tag', text: 'roll-up' }) : null,
      }));
    clear(body);
    body.appendChild(
      new Table({
        caption: 'Chart of accounts',
        columns: [
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type' },
          { key: 'balance', label: 'Balance', numeric: true },
          { key: 'flags', label: '' },
        ],
        rows,
        empty: 'No account matches that filter.',
      }).render(),
    );
  };

  search.addEventListener('input', draw);
  typeFilter.addEventListener('change', draw);
  draw();

  return h(
    'div',
    null,
    pageHead(
      'Chart of accounts',
      `${accounts.accounts.length} accounts as of ${trial.report.asOf}. A debit balance holds value; a credit balance is owed.`,
    ),
    card(
      h(
        'div',
        { class: 'form-row' },
        h('div', { class: 'field' }, h('label', { text: 'Search' }), search),
        h('div', { class: 'field' }, h('label', { text: 'Type' }), typeFilter),
      ),
      body,
    ),
    newAccountCard(),
  );
}

function newAccountCard() {
  const notice = h('div', { class: 'notice', hidden: true });
  const code = h('input', { type: 'text', placeholder: '1350', maxlength: '16', required: true });
  const name = h('input', {
    type: 'text',
    placeholder: 'Prepaid insurance',
    maxlength: '120',
    required: true,
  });
  const type = h('select', null, ...ACCOUNT_TYPES.map((value) => h('option', { value }, value)));
  const parent = h(
    'select',
    null,
    h('option', { value: '' }, 'No parent'),
    ...accountOptions(undefined).map((option) =>
      h('option', { value: option.getAttribute('value') }, option.textContent),
    ),
  );
  const description = h('input', {
    type: 'text',
    placeholder: 'What belongs here',
    maxlength: '500',
  });

  return h(
    'form',
    {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        clearError(notice);
        try {
          const result = await api.createAccount({
            code: code.value.trim().toUpperCase(),
            name: name.value.trim(),
            type: type.value,
            ...(parent.value === '' ? {} : { parentCode: parent.value }),
            ...(description.value.trim() === '' ? {} : { description: description.value.trim() }),
          });
          code.value = '';
          name.value = '';
          description.value = '';
          notice.className = 'notice notice--ok';
          clear(notice);
          notice.hidden = false;
          notice.append(
            h('p', { class: 'notice__title' }, `${result.account.code} is ready to post to.`),
          );
          flash(`Added account ${result.account.code}.`);
          await refresh();
        } catch (error) {
          notice.className = 'notice';
          showError(notice, error);
        }
      },
    },
    h('h2', { text: 'Add an account' }),
    h(
      'div',
      { class: 'form-row' },
      h('div', { class: 'field' }, h('label', { text: 'Code' }), code),
      h('div', { class: 'field' }, h('label', { text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { text: 'Type' }), type),
      h('div', { class: 'field' }, h('label', { text: 'Parent' }), parent),
      h('div', { class: 'field' }, h('label', { text: 'Description' }), description),
    ),
    notice,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'button button--primary', type: 'submit' }, 'Create account'),
    ),
  );
}

/* ---------------------------------------------------------------- reports */

const REPORTS = [
  ['trial-balance', 'Trial balance'],
  ['balance-sheet', 'Balance sheet'],
  ['income-statement', 'Income statement'],
  ['account', 'Account statement'],
];
let reportChoice = 'trial-balance';

async function reportsView() {
  const tabs = h(
    'div',
    { class: 'tabs' },
    ...REPORTS.map(([value, label]) => {
      const button = h('button', { class: 'tab', type: 'button' }, label);
      if (value === reportChoice) {
        button.setAttribute('aria-current', 'page');
      }
      button.addEventListener('click', () => {
        reportChoice = value;
        render();
      });
      return button;
    }),
  );
  const output = h('div', null, h('p', { class: 'loading', text: 'Calculating' }));

  const draw = async () => {
    clear(output);
    output.append(h('p', { class: 'loading', text: 'Calculating' }));
    try {
      const node = await reportNode();
      clear(output);
      output.append(node);
    } catch (error) {
      clear(output);
      output.append(card(errorBox(error)));
    }
  };

  async function reportNode() {
    if (reportChoice === 'trial-balance') {
      const { report } = await api.trialBalance(period.to);
      return card(
        h('h2', { text: 'Trial balance' }),
        h(
          'p',
          { class: 'lede' },
          `Every account with a balance as of ${report.asOf}. Roll-up rows are marked (total); the ` +
            'footer counts leaf accounts only.',
        ),
        new Table({
          caption: 'Trial balance',
          columns: [
            { key: 'code', label: 'Code' },
            { key: 'name', label: 'Account' },
            { key: 'debit', label: 'Debit', numeric: true },
            { key: 'credit', label: 'Credit', numeric: true },
          ],
          rows: report.rows.map((row) => ({
            isSubtotal: row.isSubtotal,
            code: h('span', { class: 'code', text: row.isSubtotal ? '' : row.code }),
            name: lineName(row),
            debit: moneyCell(row.debit),
            credit: moneyCell(row.credit),
          })),
          rowClass: (row) => (row.isSubtotal ? 'subtotal' : undefined),
          empty: 'No balances yet.',
        }).render(),
        h(
          'div',
          { class: 'actions' },
          h(
            'span',
            { class: 'entry__meta' },
            `Debits ${formatMoney(report.totals.debit)}${DOT}Credits ${formatMoney(report.totals.credit)}`,
          ),
          report.totals.balanced
            ? h('span', { class: 'chip chip--ok', text: 'balanced' })
            : h('span', {
                class: 'chip chip--bad',
                text: `out by ${formatMoney(report.totals.difference)}`,
              }),
        ),
      );
    }

    if (reportChoice === 'balance-sheet') {
      const { report } = await api.balanceSheet(period.to);
      return card(
        h('h2', { text: 'Balance sheet' }),
        h('p', {
          class: 'lede',
          text: `As of ${report.asOf}. Assets should equal liabilities plus equity.`,
        }),
        h(
          'div',
          { class: 'grid grid--two' },
          h('div', null, h('h3', { text: report.assets.title }), sectionTable(report.assets)),
          h(
            'div',
            null,
            h('h3', { text: report.liabilities.title }),
            sectionTable(report.liabilities, { asObligation: true }),
          ),
          h('div', null, h('h3', { text: report.equity.title }), sectionTable(report.equity)),
        ),
        h(
          'div',
          { class: 'grid grid--stats' },
          stat('Total assets', formatMoney(report.totalAssets)),
          stat('Current earnings', formatMoney(report.currentEarnings)),
          stat(
            'Liabilities and equity',
            formatMoney(report.totalLiabilitiesAndEquity),
            'net, so the two sides add up',
          ),
          report.balanced
            ? stat('Check', 'Balanced', 'assets equal claims', 'pos')
            : stat('Check', 'Out', formatMoney(report.difference), 'neg'),
        ),
      );
    }

    if (reportChoice === 'income-statement') {
      const { report } = await api.incomeStatement(period.from, period.to);
      return card(
        h('h2', { text: 'Income statement' }),
        h(
          'p',
          { class: 'lede' },
          `${report.from} to ${report.to}. Revenue less expenses is the period's profit or loss.`,
        ),
        h(
          'div',
          { class: 'grid grid--two' },
          h('div', null, h('h3', { text: report.revenue.title }), sectionTable(report.revenue)),
          h('div', null, h('h3', { text: report.expenses.title }), sectionTable(report.expenses)),
        ),
        h(
          'div',
          { class: 'grid grid--stats' },
          stat('Revenue', formatMoney(report.totalRevenue)),
          stat('Expenses', formatMoney(report.totalExpenses)),
          stat(
            'Net income',
            formatMoney(report.netIncome),
            'Close the period to move this into retained earnings',
            isNegative(report.netIncome) ? 'neg' : 'pos',
          ),
        ),
      );
    }

    const picker = h(
      'select',
      null,
      h('option', { value: '' }, 'Choose an account'),
      ...accountOptions(book.accounts.find((account) => !account.computed)?.code),
    );
    const statement = h('div');

    const load = async () => {
      if (picker.value === '') {
        clear(statement);
        statement.append(h('p', { class: 'empty', text: 'Pick an account to see its ledger.' }));
        return;
      }
      clear(statement);
      statement.append(h('p', { class: 'loading', text: 'Calculating' }));
      try {
        const { report } = await api.accountStatement(picker.value, period.from, period.to);
        clear(statement);
        statement.append(
          card(
            h('h2', { text: `${report.account.code}${DOT}${report.account.name}` }),
            h(
              'div',
              { class: 'grid grid--stats' },
              stat('Opening', formatMoney(report.openingBalance)),
              stat('Debits', formatMoney(report.totalDebits)),
              stat('Credits', formatMoney(report.totalCredits)),
              stat(
                'Closing',
                formatMoney(report.closingBalance),
                null,
                isNegative(report.closingBalance) ? 'neg' : '',
              ),
            ),
            new Table({
              caption: 'Account statement',
              columns: [
                { key: 'date', label: 'Date' },
                { key: 'memo', label: 'Memo' },
                { key: 'side', label: 'Dr/Cr' },
                { key: 'amount', label: 'Amount', numeric: true },
                { key: 'running', label: 'Balance', numeric: true },
              ],
              rows: report.lines.map((line) => ({
                date: line.date,
                memo: line.memo ?? EM_DASH,
                side: line.side === 'debit' ? 'Dr' : 'Cr',
                amount: line.amount.decimal,
                running: line.runningBalance.decimal,
              })),
              empty: 'No movement in this range.',
            }).render(),
          ),
        );
      } catch (error) {
        clear(statement);
        statement.append(card(errorBox(error)));
      }
    };

    picker.addEventListener('change', () => {
      load().catch((error) => flash(error.message, true));
    });
    await load();

    return h(
      'div',
      null,
      card(h('div', { class: 'field' }, h('label', { text: 'Account' }), picker)),
      statement,
    );
  }

  await draw();
  return h(
    'div',
    null,
    pageHead('Reports', 'The same numbers the API returns, laid out to be read.'),
    tabs,
    card(periodPicker(() => draw())),
    output,
  );
}

/* ------------------------------------------------------------------ rates */

async function ratesView() {
  const { rates } = await api.rates();
  const notice = h('div', { class: 'notice', hidden: true });
  const base = h('input', { type: 'text', value: book.currency, maxlength: '3' });
  const quote = h('input', { type: 'text', value: 'EUR', maxlength: '3' });
  const rate = h('input', { type: 'text', value: '1.00', inputmode: 'decimal' });
  const date = h('input', { type: 'date', value: today() });
  const source = h('input', { type: 'text', placeholder: 'ecb, bank, manual', maxlength: '64' });

  return h(
    'div',
    null,
    pageHead(
      'Currencies',
      `${rates.length} rate${rates.length === 1 ? '' : 's'} on file. The book is kept in ${book.currency}.`,
    ),
    card(
      new Table({
        caption: 'Exchange rates',
        columns: [
          { key: 'pair', label: 'Pair' },
          { key: 'rate', label: 'Rate', numeric: true },
          { key: 'date', label: 'Effective' },
          { key: 'source', label: 'Source' },
        ],
        rows: rates
          .slice()
          .reverse()
          .map((row) => ({
            pair: `${row.base}${ARROW}${row.quote}`,
            rate: row.rate,
            date: row.effectiveDate,
            source: row.source ?? EM_DASH,
          })),
        empty: 'No rates recorded. Reports stay in the functional currency until one exists.',
      }).render(),
    ),
    h(
      'form',
      {
        class: 'card',
        onsubmit: async (event) => {
          event.preventDefault();
          clearError(notice);
          try {
            await api.recordRate({
              base: base.value.trim().toUpperCase(),
              quote: quote.value.trim().toUpperCase(),
              rate: rate.value.trim(),
              effectiveDate: date.value,
              ...(source.value.trim() === '' ? {} : { source: source.value.trim() }),
            });
            flash('Rate recorded.');
            await refresh();
            await render();
          } catch (error) {
            notice.className = 'notice';
            showError(notice, error);
          }
        },
      },
      h('h2', { text: 'Record an exchange rate' }),
      h(
        'p',
        { class: 'lede' },
        'A report in another currency needs a rate. The engine refuses to invent one, so say where yours came from.',
      ),
      h(
        'div',
        { class: 'form-row' },
        h('div', { class: 'field' }, h('label', { text: 'From' }), base),
        h('div', { class: 'field' }, h('label', { text: 'To' }), quote),
        h('div', { class: 'field' }, h('label', { text: 'Rate' }), rate),
        h('div', { class: 'field' }, h('label', { text: 'Effective' }), date),
        h('div', { class: 'field' }, h('label', { text: 'Source' }), source),
      ),
      notice,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'button button--primary', type: 'submit' }, 'Save rate'),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ close */

async function closeView() {
  const notice = h('div', { class: 'notice notice--warn' });
  notice.append(
    h('p', { class: 'notice__title' }, 'Closing a period is a seal, not an undo button.'),
    h(
      'p',
      null,
      'The engine posts a closing entry that moves the result into retained earnings, then refuses any ' +
        'later entry dated inside those dates. Corrections have to be dated after the close.',
    ),
  );

  const to = h('input', { type: 'date', value: period.to, required: true });
  const from = h('input', { type: 'date', value: monthStart(new Date(`${period.to}T00:00:00`)) });
  const closedBy = h('input', { type: 'text', placeholder: 'Your name', maxlength: '64' });

  return h(
    'div',
    null,
    pageHead(
      'Close period',
      `${book.periods.length} period${book.periods.length === 1 ? '' : 's'} already sealed.`,
    ),
    card(
      new Table({
        caption: 'Closed periods',
        columns: [
          { key: 'period', label: 'Period' },
          { key: 'entries', label: 'Entries', numeric: true },
          { key: 'closedAt', label: 'Sealed at' },
          { key: 'by', label: 'By' },
        ],
        rows: book.periods.map((row) => ({
          period: h(
            'span',
            null,
            h('span', { class: 'chip chip--closed', text: 'closed' }),
            ` ${row.from}${ARROW}${row.to}`,
          ),
          entries: String(row.entryIds.length),
          closedAt: row.closedAt,
          by: row.closedBy ?? EM_DASH,
        })),
        empty: 'Nothing is closed yet, so the books are still editable end to end.',
      }).render(),
    ),
    h(
      'form',
      {
        class: 'card',
        onsubmit: async (event) => {
          event.preventDefault();
          const ok = await confirmAsk(
            'Close this period?',
            `Every date from ${from.value || 'the start of the book'} to ${to.value} will be sealed, ` +
              'and the period result moves into retained earnings. This cannot be reopened.',
          );
          if (!ok) {
            return;
          }
          clearError(notice);
          notice.className = 'notice notice--warn';
          try {
            const result = await api.closePeriod({
              to: to.value,
              ...(from.value === '' ? {} : { from: from.value }),
              ...(closedBy.value.trim() === '' ? {} : { closedBy: closedBy.value.trim() }),
            });
            flash(
              `Closed ${result.period.from} to ${result.period.to} with ${
                result.entries.length
              } closing entry.`,
            );
            await refresh();
            await render();
          } catch (error) {
            notice.className = 'notice';
            showError(notice, error);
          }
        },
      },
      h('h2', { text: 'Close a period' }),
      notice,
      h(
        'div',
        { class: 'form-row' },
        h('div', { class: 'field' }, h('label', { text: 'From' }), from),
        h('div', { class: 'field' }, h('label', { text: 'To' }), to),
        h('div', { class: 'field' }, h('label', { text: 'Closed by' }), closedBy),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'button button--primary', type: 'submit' }, 'Close period'),
      ),
    ),
  );
}

/* ------------------------------------------------------------------- boot */

async function refresh() {
  const [accounts, periods, integrity, trial] = await Promise.all([
    api.accounts(),
    api.periods(),
    api.verify().catch((error) => ({
      report: { balanced: false, entries: 0, accounts: 0, problems: [error.message] },
    })),
    api.trialBalance(period.to),
  ]);
  book.accounts = accounts.accounts;
  book.periods = periods.periods;
  book.integrity = integrity.report;
  book.currency = trial.report.functionalCurrency;
  book.exponent = trial.report.totals.debit.exponent;
  verifyChip.textContent = integrity.report.balanced
    ? `balanced ${DOT}${integrity.report.entries} entries`
    : 'not balanced';
  verifyChip.className = `chip ${integrity.report.balanced ? 'chip--ok' : 'chip--bad'}`;
  bookMeta.textContent = `${book.accounts.length} accounts ${DOT}${book.periods.length} closed period(s)`;
  if (!periodPinned) {
    await pinPeriodToActivity();
  }
}

/**
 * A dashboard for a month with nothing in it is the first thing a new user sees,
 * and it looks like a broken app. If the current month is empty, jump to the
 * month of the most recent entry. Done once, on load: after that the date
 * fields are the user's business.
 */
async function pinPeriodToActivity() {
  const current = await api.entries(period.from, period.to);
  if (current.entries.length > 0) {
    periodPinned = true;
    return;
  }
  const all = await api.entries('1900-01-01', today());
  const latest = all.entries.at(-1);
  if (latest === undefined) {
    periodPinned = true;
    return;
  }
  period.to = latest.date;
  period.from = monthStart(new Date(`${latest.date}T00:00:00`));
  periodPinned = true;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => navigate(tab.dataset.view));
}
document.querySelector('#new-entry-shortcut').addEventListener('click', () => navigate('entry'));
dialogForm.addEventListener('submit', (event) => {
  event.preventDefault();
  dialog.close(event.submitter?.value === 'confirm' ? 'confirm' : 'cancel');
});
window.addEventListener('hashchange', () => {
  render();
});

refresh()
  .then(render)
  .catch((error) => {
    clear(view);
    view.append(
      card(
        h('h1', { text: 'The book would not open' }),
        h(
          'p',
          { class: 'lede' },
          'The API did not answer. Start the server, then reload this page.',
        ),
        errorBox(error),
      ),
    );
  });
