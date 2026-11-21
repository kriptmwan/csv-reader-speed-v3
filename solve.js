// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// Written from the task spec in the kit's RULES.txt, so it returns exactly
// what csv-reader returns for every input {text, header}: {columns, rows,
// errors}. The reference reads one character at a time; this one does not.
//
// Speed comes from two observations about the drawn cases:
//  - most records are plain lines: no quotes, no stray CR. A plain record
//    is taken whole — one native search finds its line break, two more
//    prove it holds no quote and no stray CR — and split on commas in one
//    native call, instead of a JavaScript loop per character.
//  - only records holding a quote or a stray CR go through the field
//    reader below, which follows the reference's broken-row policy exactly,
//    scanning with native indexOf searches between the special characters
//    (comma, quote, CR, LF) and slicing the stretches between them.
//
// Broken-row policy, as specified:
//  - a U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF; a line left with no characters is no
//    record; outside quotes a CR not followed by LF is dropped (stray_cr);
//  - a field opening with a quote runs to the next quote that is not
//    doubled, "" inside it one quote, each CRLF or lone CR inside it read
//    as LF; what follows its closing quote, up to the next comma or line
//    break, is appended as it stands (quote_junk, when the field ends); a
//    quote that never closes is a literal character and the text after it
//    is read again as unquoted (unterminated_quote); a quote inside an
//    unquoted field is a literal character; fields stay strings, never
//    trimmed or converted;
//  - columns is the first record when header is true, else null; rows are
//    the records after it, each padded with "" (short_row, with fields: its
//    field count) or cut (long_row, with extra: the cut fields) to the
//    first record's width;
//  - each error is {code, line, row}, in the order met; line is the
//    1-based line its record starts on, counting every LF, CRLF and lone CR
//    inside quotes, and row is its record's index in rows (null for the
//    header).

// How a field ended: at a comma (the record goes on), at a line break or
// at the end of the text (the record ends).
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the
  // field and how it ended; `added` counts the characters kept.
  function readUnquoted(value, start) {
    let added = 0;
    let p = start;
    let seg = start;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      const ri = text.indexOf('\r', p);
      let m = -1;
      let kind = 0;
      if (ci !== -1) { m = ci; kind = 1; }
      if (ni !== -1 && (m === -1 || ni < m)) { m = ni; kind = 2; }
      if (ri !== -1 && (m === -1 || ri < m)) { m = ri; kind = 3; }
      if (m === -1) {
        if (seg < n) { value += text.slice(seg); added += n - seg; }
        pos = n;
        return { value, ended: END, added };
      }
      if (kind === 1) {
        value += text.slice(seg, m);
        added += m - seg;
        pos = m + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === 2) {
        value += text.slice(seg, m);
        added += m - seg;
        pos = m + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (text.charCodeAt(m + 1) === 10) {
        value += text.slice(seg, m);
        added += m - seg;
        pos = m + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(seg, m);
      added += m - seg;
      p = m + 1;
      seg = m + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = open + 1;
    let p = open + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      const cr = text.indexOf('\r', p);
      const lf = text.indexOf('\n', p);
      let m = -1;
      let kind = 0;
      if (q !== -1) { m = q; kind = 1; }
      if (cr !== -1 && (m === -1 || cr < m)) { m = cr; kind = 2; }
      if (lf !== -1 && (m === -1 || lf < m)) { m = lf; kind = 3; }
      if (m === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"', open + 1);
      }
      if (kind === 1) {
        if (text.charCodeAt(q + 1) === 34) {
          if (parts === null) parts = [text.slice(segStart, q), '"'];
          else parts.push(text.slice(segStart, q), '"');
          p = q + 2;
          segStart = q + 2;
          continue;
        }
        let value;
        if (parts === null) value = text.slice(segStart, q);
        else {
          parts.push(text.slice(segStart, q));
          value = parts.join('');
        }
        pos = q + 1;
        if (pos >= n) return { value, ended: END, added: 0 };
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          return { value, ended: COMMA, added: 0 };
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          return { value, ended: LINE_BREAK, added: 0 };
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added: 0 };
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        const junk = readUnquoted(value, pos);
        if (junk.added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        return junk;
      }
      // CRLF and a lone CR inside quotes are each one LF.
      if (parts === null) parts = [text.slice(segStart, m), '\n'];
      else parts.push(text.slice(segStart, m), '\n');
      line += 1;
      p = kind === 2 && text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
      segStart = p;
    }
  }

  // Finishes a record's fields: the header, or a row at the first
  // record's width. Returns nothing; a line left with no characters is
  // no record.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a plain record holds no quote and no stray CR, so the
    // whole line is split on commas in one native call. The line ends at
    // the next LF (or the end of the text); a CR just before it is the
    // CRLF's, not a stray one.
    const le = text.indexOf('\n', pos);
    const contentEnd = le === -1 ? n : text.charCodeAt(le - 1) === 13 ? le - 1 : le;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= contentEnd) {
      const ri = text.indexOf('\r', pos);
      if (ri === -1 || ri >= contentEnd) {
        const fields = text.slice(pos, contentEnd).split(',');
        finishRecord(fields, false);
        if (le === -1) {
          pos = n;
        } else {
          pos = le + 1;
          line += 1;
        }
        continue;
      }
    }

    // Slow path: a record holding a quote or a stray CR, read field by
    // field.
    const fields = [];
    let quoted = false;
    for (;;) {
      let field;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        field = readQuoted();
      } else {
        quoted = false;
        field = readUnquoted('', pos);
      }
      fields.push(field.value);
      if (field.ended !== COMMA) break;
    }
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
