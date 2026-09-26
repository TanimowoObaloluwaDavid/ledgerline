/**
 * A very small DOM helper.
 *
 * The UI is plain ES modules served straight from `public/` — no bundler, no
 * framework, nothing to install. That keeps the whole web app inside a folder
 * you can read in one sitting, at the cost of building elements by hand, which
 * is what this does.
 *
 * Text is always set through `textContent`, never `innerHTML`. The ledger
 * contains whatever the user typed into a memo field, and a memo field is not
 * a place to evaluate markup.
 */

/**
 * Applies one props object to an element.
 *
 * Split out of `h` so each branch lives in its own small function: a list of
 * attribute names is easier to review than a switch inside an element builder.
 *
 * @param {HTMLElement} element
 * @param {Record<string, unknown>} props
 */
// A props object is a small tagged union: class, text, dataset, an event
// handler, or a plain attribute. Dispatching on the key is the whole job, and
// splitting it further would only move the branches somewhere less readable.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per prop kind
function applyProps(element, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [name, data] of Object.entries(/** @type {Record<string, string>} */ (value))) {
        element.dataset[name] = data;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }
}

/**
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const element = document.createElement(tag);
  if (props !== null) {
    applyProps(element, props);
  }
  append(element, children);
  return element;
}

/** @param {Node} parent @param {readonly unknown[]} children */
export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') {
      continue;
    }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** @param {Element} parent */
export function clear(parent) {
  parent.replaceChildren();
}

/** @param {Element} element @param {unknown} error */
export function showError(element, error) {
  clear(element);
  element.hidden = false;
  element.appendChild(
    h(
      'p',
      { class: 'notice__title' },
      h('strong', { text: error?.code ?? 'Error' }),
      h('span', { text: ' ' }),
      String(error?.message ?? error),
    ),
  );
  const details = error?.details;
  if (details && Object.keys(details).length > 0) {
    element.appendChild(
      h('pre', { class: 'notice__details', text: JSON.stringify(details, null, 2) }),
    );
  }
}

/** @param {Element} element */
export function clearError(element) {
  clear(element);
  element.hidden = true;
}

/** A table with a caption for screen readers and a scroll container for phones. */
export class Table {
  /**
   * @param {{ columns: readonly { key: string, label: string, numeric?: boolean, className?: string }[],
   *   rows: readonly Record<string, unknown>[], caption: string, empty?: string,
   *   rowClass?: (row: Record<string, unknown>) => string | undefined }} config
   */
  constructor({ columns, rows, caption, empty = 'Nothing to show yet.', rowClass }) {
    this.columns = columns;
    this.rows = rows;
    this.caption = caption;
    this.empty = empty;
    this.rowClass = rowClass;
  }

  /** @returns {HTMLElement} */
  render() {
    const head = h(
      'tr',
      null,
      ...this.columns.map((column) =>
        h('th', { scope: 'col', class: column.numeric ? 'num' : undefined }, column.label),
      ),
    );
    const body =
      this.rows.length === 0
        ? h(
            'tr',
            null,
            h('td', { colspan: String(this.columns.length), class: 'empty' }, this.empty),
          )
        : this.rows.map((row) =>
            h(
              'tr',
              { class: this.rowClass?.(row) },
              ...this.columns.map((column) => {
                const value = row[column.key];
                const content =
                  value instanceof Node || Array.isArray(value) ? value : String(value ?? '—');
                return h(
                  'td',
                  {
                    class:
                      [column.numeric ? 'num' : '', column.className ?? ''].join(' ').trim() ||
                      undefined,
                  },
                  content,
                );
              }),
            ),
          );

    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'table' },
        h('caption', { class: 'visually-hidden', text: this.caption }),
        h('thead', null, head),
        h('tbody', null, ...body),
      ),
    );
  }
}
