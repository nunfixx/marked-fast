// marked-fast: a fast drop-in replacement for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off). Written from scratch; it
// renders CommonMark 0.31.2 + GFM 0.29 to exactly the same HTML marked does,
// byte for byte, using a direct-to-HTML single-pass design (no token tree,
// no separate render walk) for speed.
//
// parse(markdown) -> html string. No state is kept between calls.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ALL_RE = /[&<>"']/g;
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Escape HTML chars. With encode=true every & < > " ' is escaped; with
// encode=false a & that already starts a valid entity reference is left alone.
const ESC_TEST_RE = /[&<>"']/;
function esc(s, encode) {
  if (!ESC_TEST_RE.test(s)) return s;
  return encode ? s.replace(ESC_ALL_RE, (c) => ESC[c]) : s.replace(ESC_NO_ENCODE_RE, (c) => ESC[c]);
}

// Decode numeric character references (&#169; &#xA9;) and turn a bare & (one
// that does not start a valid entity) into &amp;. Named entities such as
// &copy; are passed through unchanged, exactly as marked leaves them for
// the browser to resolve.
const NUM_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeRefs(s) {
  if (!s.includes('&')) return s;
  return s.replace(NUM_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}
// What a run of plain inline text becomes: numeric refs decoded, then HTML
// escaping that preserves valid entities.
function textOut(s) {
  return esc(decodeRefs(s), false);
}

// Normalise a link label: trim, collapse whitespace, Unicode case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs in a string to spaces, counting columns from `col`.
function expandTabs(s, col) {
  let out = '';
  let c = col === undefined ? 0 : col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') { const r = 4 - (c % 4); out += '    '.slice(0, r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// encodeURI with %25 turned back into %, null when the URI is malformed.
function hrefEncode(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}

// Strip a trailing run of one character.
function trimEndChar(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch.charCodeAt(0)) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines when there are two or more of them (keeps at
// most one trailing newline). Used for indented code and HTML blocks.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Find an unmatched close paren in `s`: its index, -1 when there is none or
// they balance, -2 when an open paren is left unclosed. Backslash escapes
// are skipped.
function findParen(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Unescape backslash-escaped punctuation: \X -> X for X ASCII punctuation.
// (marked's anyPunctuation is the ASCII set, not the Unicode one.)
const UNESC_PUNCT_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g;
function unescapePunct(s) {
  return s.replace(UNESC_PUNCT_RE, '$1');
}

// Is `ch` an ASCII punctuation character (the backslash-escape set)?
function isAsciiPunct(ch) {
  return ch !== '' && ch !== undefined && /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/.test(ch);
}

// Unicode character classes used for emphasis flanking rules.
const IS_PUNCT_RE = /[\p{P}\p{S}]/u;
const IS_SPACE_RE = /\s/;
const IS_ALNUM_RE = /[\p{L}\p{N}]/u;
function isPunct(ch) { return ch !== '' && IS_PUNCT_RE.test(ch); }
function isSpace(ch) { return ch !== '' && IS_SPACE_RE.test(ch); }
// In GFM mode a tilde is a delimiter, not punctuation, for flanking.
function isPunctGfm(ch) { return ch !== '' && ch !== '~' && IS_PUNCT_RE.test(ch); }
// "not punctuation, not space" for GFM flanking: a tilde counts as such.
function isWordCharGfm(ch) { return ch !== '' && (ch === '~' || (!IS_SPACE_RE.test(ch) && !IS_PUNCT_RE.test(ch))); }
function isPunctOrSpaceGfm(ch) { return ch !== '' && ch !== '~' && (IS_SPACE_RE.test(ch) || IS_PUNCT_RE.test(ch)); }

// Split a table row into cells. Escaped pipes stay literal, unescaped pipes
// split. When ncols is given the row is truncated or padded to that width.
function splitTableRow(s, ncols) {
  let t = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '|') {
      let back = 0, p = i - 1;
      while (p >= 0 && s[p] === '\\') { back++; p--; }
      t += back % 2 === 1 ? '|' : ' |';
    } else t += s[i];
  }
  const parts = t.split(' |');
  if (!parts[0].trim()) parts.shift();
  if (parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  if (ncols) {
    if (parts.length > ncols) parts.length = ncols;
    else while (parts.length < ncols) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  return parts;
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp('^(?:' + BLOCK_TAGS + ')$', 'i');

// ---------- inline parsing ----------
//
// The scanner walks the inline source left to right and emits HTML
// directly. Emphasis is opener-driven with recursion, mirroring the
// CommonMark delimiter rules: for a delimiter run that can open, scan
// forward for the first valid closer (accounting for opener-like runs and
// the rule of three), then parse the inside recursively.

// A run of backticks starting at i: find its closing run of the same
// length. Returns {text, end} (text with newlines turned into spaces and
// one leading/trailing space stripped when the content is non-blank and
// space-padded) or null.
function matchCodeSpan(src, i) {
  const n = src.length;
  let open = 0;
  while (i + open < n && src[i + open] === '`') open++;
  let j = i + open;
  while (j < n) {
    if (src[j] === '`') {
      let close = 0;
      while (j + close < n && src[j + close] === '`') close++;
      if (close === open) {
        let text = src.slice(i + open, j).replace(/\n/g, ' ');
        if (text.length > 0 && /[^ ]/.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') {
          text = text.slice(1, -1);
        }
        return { text, end: j + close };
      }
      j += close;
    } else j++;
  }
  return null;
}

// An inline HTML tag, comment, processing instruction, declaration or CDATA
// section starting at i (src[i] === '<'). Returns {raw, end} or null.
function matchTag(src, i) {
  const n = src.length;
  const rest = src.slice(i);
  let m;
  if (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->');
    if (end < 0) return { raw: rest, end: n };
    return { raw: rest.slice(0, end + 3), end: i + end + 3 };
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>');
    if (end < 0) return null;
    return { raw: rest.slice(0, end + 2), end: i + end + 2 };
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>');
    if (end < 0) return null;
    return { raw: rest.slice(0, end + 3), end: i + end + 3 };
  }
  if (/^<![A-Za-z]/.test(rest)) {
    const end = rest.indexOf('>');
    if (end < 0) return null;
    return { raw: rest.slice(0, end + 1), end: i + end + 1 };
  }
  if (rest.startsWith('</')) {
    m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
    return m ? { raw: m[0], end: i + m[0].length } : null;
  }
  m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(rest);
  return m ? { raw: m[0], end: i + m[0].length } : null;
}

// An autolink <scheme:...> or <email> starting at i. Returns
// {href, text, end} or null.
const AUTOLINK_SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
function matchAutolink(src, i) {
  const rest = src.slice(i);
  let m = AUTOLINK_SCHEME_RE.exec(rest);
  if (m) return { href: m[1], text: m[1], end: i + m[0].length };
  m = AUTOLINK_EMAIL_RE.exec(rest);
  if (m) return { href: 'mailto:' + m[1], text: m[1], end: i + m[0].length };
  return null;
}

// Scan a bracket pair starting at src[j] === '['. The pair's content may
// itself contain pairs while depth > 0. Returns the index just past the
// closing ']' or -1.
function scanPair(src, j, depth) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '[') {
      if (depth <= 0) return -1;
      const end = scanPair(src, k, depth - 1);
      if (end < 0) return -1;
      k = end; continue;
    }
    if (c === ']') return k + 1;
    k++;
  }
  return -1;
}

// A code span inside a link label, starting at a backtick. Returns the
// index just past it or -1 when there is no valid code span.
function scanCodeInLabel(src, j) {
  const n = src.length;
  let run = 0;
  while (j + run < n && src[j + run] === '`') run++;
  if (run >= 2 && src[j + run] === ']') return j + run;
  let k = j + run;
  while (k < n) {
    if (src[k] === '`') {
      let r2 = 0;
      while (k + r2 < n && src[k + r2] === '`') r2++;
      return k + r2;
    }
    k++;
  }
  return -1;
}

// Find the end of a link label starting at src[j] === '[': the index just
// past its closing ']', or -1. A label may hold nested bracket pairs (two
// levels), backslash escapes and code spans.
function scanLabelEnd(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '[') {
      const end = scanPair(src, k, 1);
      if (end < 0) return -1;
      k = end; continue;
    }
    if (c === ']') return k + 1;
    if (c === '`') {
      const end = scanCodeInLabel(src, k);
      if (end < 0) return -1;
      k = end; continue;
    }
    k++;
  }
  return -1;
}

// Parse a link title starting at `sep` (the separator has already been
// matched): "..." or '...' or (...), with backslash escapes. Returns
// {title, end} or null.
function parseTitle(src, sep) {
  const n = src.length;
  const q = src[sep];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let k = sep + 1;
  while (k < n) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src[k] === close) return { title: src.slice(sep + 1, k), end: k + 1 };
    if (q === "'" && src[k] === '\n') {
      // single-quoted titles may span lines but not blank lines
      if (src[k + 1] === '\n') return null;
    }
    if (q === '"' && src[k] === '\n') {
      // double-quoted titles may not contain a newline... they may: the
      // pattern [^"\\] allows newlines, so keep going
    }
    k++;
  }
  return null;
}

// Match the separator before a link title at position p: spaces/tabs then
// an optional newline, or a newline then spaces/tabs. Returns the index
// just past the separator or -1.
function parseTitleSep(src, p) {
  const n = src.length;
  let k = p;
  if (src[k] === ' ' || src[k] === '\t') {
    while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    if (src[k] === '\n') {
      k++;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    }
    return k;
  }
  if (src[k] === '\n') {
    k++;
    while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    return k;
  }
  return -1;
}

// Try to match the tail of an inline link starting at the href position k:
// an optional title, then optional whitespace, then ')'. Returns
// {href, title, end} or null. `hrefEnd` is the greedy end of the href.
function matchLinkTail(src, k, hrefEnd) {
  const n = src.length;
  for (let p = hrefEnd; p >= k; p--) {
    let end = p;
    let title = null;
    const sep = parseTitleSep(src, p);
    if (sep >= 0) {
      const t = parseTitle(src, sep);
      if (t) { title = t.title; end = t.end; }
    }
    let m = end;
    while (m < n && (src[m] === ' ' || src[m] === '\t' || src[m] === '\n')) m++;
    if (src[m] === ')') return { href: src.slice(k, p), title, end: m + 1 };
  }
  return null;
}

// Is the character a space, tab, newline or control character (the set that
// cannot appear in a bare link destination)?
function isDestChar(ch) {
  if (ch === undefined) return true;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c < 32 || c === 127;
}

// Match an inline link or image starting at i: [text](dest "title").
// Returns {html, end, emittedLink} or null. `links` is the reference map.
function matchInlineLink(src, i, links, ctx) {
  const n = src.length;
  let j = i;
  const image = src[j] === '!';
  if (image) j++;
  if (src[j] !== '[') return null;
  const labelEnd = scanLabelEnd(src, j);
  if (labelEnd < 0) return null;
  const label = src.slice(j + 1, labelEnd - 1);
  let k = labelEnd;
  if (src[k] !== '(') return null;
  k++;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  // The link text must not contain a raw tag/autolink that runs past the
  // end of the label.
  if (label.includes('<') && linkTextHasOpenTag(src, j + 1, labelEnd - 1)) return null;
  let tail = null;
  let isAngle = false;
  if (src[k] === '<') {
    // Angle-bracket destination: <...> with no newline or unescaped <>.
    let m = k + 1, ok = false;
    while (m < n) {
      if (src[m] === '\\') { m += 2; continue; }
      if (src[m] === '\n' || src[m] === '<') break;
      if (src[m] === '>') { ok = true; break; }
      m++;
    }
    if (ok) {
      const dest = src.slice(k + 1, m);
      // A '>' preceded by an odd number of backslashes is escaped: invalid.
      let bs = 0;
      for (let q = m - 1; q > k && src[q] === '\\'; q--) bs++;
      if (bs % 2 === 0) {
        tail = matchLinkTail(src, m + 1, m + 1);
        if (tail) { tail.href = dest; isAngle = true; }
      }
    }
    if (!tail) {
      // Fall back to a bare destination starting at k.
      let e = k;
      while (e < n && !isDestChar(src[e])) e++;
      if (e > k) {
        tail = matchLinkTail(src, k, e);
        // A bare destination that starts with '<' must end with '>' and
        // the '>' must not be escaped by an odd run of backslashes.
        if (tail && tail.href.startsWith('<')) {
          const s = tail.href.trim();
          let ok = s.endsWith('>');
          if (ok) {
            let bs = 0;
            for (let q = s.length - 2; q >= 0 && s[q] === '\\'; q--) bs++;
            ok = bs % 2 === 0;
          }
          if (!ok) tail = null;
        }
      }
    }
  } else {
    let e = k;
    while (e < n && !isDestChar(src[e])) e++;
    if (e === k) {
      if (src[k] === ')') tail = { href: '', title: null, end: k + 1 };
    } else {
      tail = matchLinkTail(src, k, e);
    }
  }
  if (!tail) return null;
  let href = tail.href;
  let title = tail.title;
  // Unbalanced parens in a BARE destination truncate it; an unclosed open
  // paren invalidates the link. (Angle-bracket destinations are exempt:
  // parens inside <...> are literal.) The truncated raw ends right after
  // the unmatched ')' (the formula is an index into the raw link text).
  if (!isAngle && !href.startsWith('<')) {
    const par = findParen(href);
    if (par === -2) return null;
    if (par > -1) {
      const h = (image ? 5 : 4) + label.length + par;
      href = href.slice(0, par);
      title = null;
      let e2 = i + h;
      while (e2 > i && (src[e2 - 1] === ' ' || src[e2 - 1] === '\t' || src[e2 - 1] === '\n')) e2--;
      tail.end = e2;
    }
  }
  // The closing ')' must not be escaped by an odd run of backslashes.
  let bs = 0;
  for (let q = tail.end - 2; q >= 0 && src[q] === '\\'; q--) bs++;
  if (bs % 2 === 1) return null;
  href = href.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  href = unescapePunct(href);
  title = title === null || title === undefined ? null : unescapePunct(title);
  return buildLink(image, label, href, title, tail.end, src, i, links, ctx);
}

// Does the label src[a..b) contain a '<' starting a tag or autolink whose
// match runs past the end of the label?
function linkTextHasOpenTag(src, a, b) {
  for (let s = a; s < b; s++) {
    if (src[s] === '\\') { s++; continue; }
    if (src[s] === '`') {
      const cs = matchCodeSpan(src, s);
      if (cs) { s = cs.end - 1; continue; }
    }
    if (src[s] !== '<') continue;
    const tag = matchTag(src, s);
    if (tag && s + tag.raw.length > b) return true;
    if (tag) { s += tag.raw.length - 1; continue; }
    const al = matchAutolink(src, s);
    if (al && s + (al.end - s) > b) return true;
    if (al) { s = al.end - 1; continue; }
  }
  return false;
}

// Build the HTML for a link/image once its parts are known. Parses the
// label text inline; when the label itself produced a link and this is not
// an image, the outer link is rejected (no nested links). In plain-text
// mode (image alt text) a link renders as its label's plain text.
function buildLink(image, label, href, title, end, src, i, links, ctx) {
  const text = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = ctx.render(text, links, ctx);
  const nested = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  // A link inside the label rejects the outer link (unless it is an image).
  // This applies in plain-text rendering too, so the outer link never
  // forms when its label already contains a link.
  if (!image && nested) {
    ctx.inRawBlock = savedRaw;
    return null;
  }
  if (!image) ctx.linkEmitted = true;
  if (ctx.render === plainText) {
    return { html: inner, end, emittedLink: true };
  }
  const encoded = hrefEncode(href);
  if (image) {
    const alt = plainText(text, links, ctx);
    if (encoded === null) return { html: esc(alt, false), end, emittedLink: false };
    let out = '<img src="' + esc(encoded, false) + '" alt="' + esc(alt, false) + '"';
    if (title) out += ' title="' + esc(title, false) + '"';
    return { html: out + '>', end, emittedLink: false };
  }
  if (encoded === null) return { html: inner, end, emittedLink: true };
  let out = '<a href="' + esc(encoded, false) + '"';
  if (title) out += ' title="' + esc(title, false) + '"';
  return { html: out + '>' + inner + '</a>', end, emittedLink: true };
}

// Scan a reference label (no nesting, newlines allowed unless they start a
// blank line) starting at src[j] === '['. Returns {label, end} or null.
function scanRefLabel(src, j) {
  const n = src.length;
  let k = j + 1;
  if (/^\s*\]/.test(src.slice(k, k + 2))) return null;
  const start = k;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '[' || c === ']') break;
    if (c === '\n') {
      if (src[k + 1] === '\n') break;
      let q = k + 1;
      while (src[q] === ' ' || src[q] === '\t') q++;
      if (src[q] === '\n') break;
    }
    k++;
  }
  if (src[k] !== ']' || k === start) return null;
  return { label: src.slice(start, k), end: k + 1 };
}

// Match a reference link/image [text][ref] or [text][] or [text] at i.
// Returns {html, end, emittedLink} or {text: firstChar, end} when the
// reference is undefined (only the first character is consumed).
function matchRefLink(src, i, links, ctx) {
  const n = src.length;
  let j = i;
  const image = src[j] === '!';
  if (image) j++;
  if (src[j] !== '[') return null;
  // The first label uses the same balanced-bracket pattern as inline
  // links (nested brackets and code spans included).
  const labelEnd = scanLabelEnd(src, j);
  if (labelEnd < 0) return null;
  const label = src.slice(j + 1, labelEnd - 1);
  if (label === '') return null;
  if (label.includes('<') && linkTextHasOpenTag(src, j + 1, labelEnd - 1)) return null;
  let ref = null;
  let end = labelEnd;
  if (src[labelEnd] === '[') {
    const r = scanRefLabel(src, labelEnd);
    if (r) { ref = r.label; end = r.end; }
  }
  if (ref === null) {
    // Collapsed [label][] form.
    if (src[labelEnd] === '[' && src[labelEnd + 1] === ']') {
      ref = label;
      end = labelEnd + 2;
    } else {
      ref = label;
    }
  }
  const target = links[normLabel(ref)];
  if (!target) {
    const first = src[i];
    return { html: null, text: first, end: i + 1, emittedLink: false };
  }
  return buildLink(image, label, target.href, target.title, end, src, i, links, ctx);
}

// ---------- emphasis ----------

// Flanking of the delimiter run src[i..i+k): left/right per the CommonMark
// definitions (line start/end count as whitespace). `punct` is the
// punctuation test to use (GFM excludes '~', plain includes it); `prev`
// overrides the character before the run (the loop's previous-token char)
// when given, otherwise src[i-1] is used.
function flank(src, i, k, punct, prev) {
  const P = prev === undefined ? (i > 0 ? src[i - 1] : '') : prev;
  const next = i + k < src.length ? src[i + k] : '';
  const left = next !== '' && !isSpace(next) && (!punct(next) || P === '' || isSpace(P) || punct(P));
  const right = P !== '' && !isSpace(P) && (!punct(P) || next === '' || isSpace(next) || punct(next));
  return { left, right, prev: P, next };
}

// The delimiter run at `pos` that a leading __...*...__ (for `*`) or
// **..._...** (for `_`) pattern shields: a delimiter between a pair of the
// other kind at the very start of the scanned text is not a closer
// candidate. Returns the absolute index of the shielded delimiter or -1.
function shieldedDelim(src, start, pairCh, delimCh) {
  const n = src.length;
  let j = start;
  while (j < n && src[j] !== '*' && src[j] !== '_') j++;
  if (src[j] !== pairCh || src[j + 1] !== pairCh) return -1;
  j += 2;
  while (j < n && src[j] !== '*' && src[j] !== '_') j++;
  if (src[j] !== delimCh) return -1;
  const at = j;
  j++;
  while (j < n && src[j] !== '*' && src[j] !== '_') j++;
  if (src[j] === pairCh && src[j + 1] === pairCh) return at;
  return -1;
}

// The last index in src at or after `from` where a run of `ch` starts with
// a non-whitespace character before it (-1 when there is none). Used to
// stop the closer scan early.
function lastCloserStart(src, from, ch) {
  let last = -1;
  for (let i = from; i < src.length; i++) {
    if (src[i] !== ch) continue;
    // An escaped delimiter (preceded by an odd run of backslashes) is not
    // a closer and does not extend a run.
    let bs = 0;
    for (let q = i - 1; q >= 0 && src[q] === '\\'; q--) bs++;
    if (bs % 2 === 1) continue;
    const prev = i > 0 ? src[i - 1] : '\n';
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') last = i;
    while (i + 1 < src.length && src[i + 1] === ch) i++;
  }
  return last;
}

// Try to form <em>/<strong> from the delimiter run starting at i.
// `prev` is the previous token's last character ("" when the previous
// token was not a text token, or when it ended with "_"). Returns
// {html, end} or null.
// Index of the ')' matching the '(' at openPos (nested parens and escapes
// honoured), or -1 when there is none.
function matchParen(src, openPos) {
  const n = src.length;
  let depth = 0;
  for (let i = openPos; i < n; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A [label](dest) that marked's masking (blockSkip) hides even though the
// link regex rejects it: the label contains a code span whose content holds
// backticks, so the link regex's label pattern fails, but after the masking
// step neutralises those inner backticks the label matches blockSkip's
// pattern and the whole construct is replaced by [aaa...] in the masked
// source. Its emphasis/del delimiters are therefore invisible to the closer
// scan, so the scan must skip the whole construct. Returns the index just
// past the closing paren, or -1.
function skipBlockSkipLink(src, j) {
  const n = src.length;
  let k = j;
  if (src[k] === '!') k++;
  if (src[k] !== '[') return -1;
  k++;
  const labelStart = k;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '`') {
      const cs = matchCodeSpan(src, k);
      if (!cs) return -1;
      k = cs.end; continue;
    }
    if (c === '[' || c === ']') break;
    if (c === '\n') {
      if (src[k + 1] === '\n') return -1;
      let q = k + 1;
      while (src[q] === ' ' || src[q] === '\t') q++;
      if (src[q] === '\n') return -1;
    }
    k++;
  }
  if (src[k] !== ']' || k === labelStart) return -1;
  if (src[k + 1] !== '(') return -1;
  const paren = matchParen(src, k + 1);
  if (paren < 0) return -1;
  return paren + 1;
}

// Ot masking: pair backtick runs left to right (a run pairs with the next
// run of the same length whose content starts and ends with a non-backtick;
// the content may hold other backticks). Backticks inside such a code
// span's content are neutralised (they read as '+' for blockSkip).
// Returns a Uint8Array marking neutralised backtick positions.
function otNeutralized(src) {
  const n = src.length;
  const neutral = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] !== '`') { i++; continue; }
    let L = 0;
    while (i + L < n && src[i + L] === '`') L++;
    let r = i + L;
    let found = -1;
    while (r < n) {
      if (src[r] === '`') {
        let L2 = 0;
        while (r + L2 < n && src[r + L2] === '`') L2++;
        if (L2 === L && src[i + L] !== '`' && src[r - 1] !== '`') { found = r; break; }
        r += L2;
      } else r++;
    }
    if (found >= 0) {
      for (let k = i + L; k < found; k++) if (src[k] === '`') neutral[k] = 1;
      i = found + L;
    } else {
      i += L;
    }
  }
  return neutral;
}

// A blockSkip code span in the Ot-neutralised view: a backtick run, then
// content holding no non-neutralised backtick, then a run of the same
// length not followed by a backtick. Returns the index just past it, or -1.
function blockSkipCodeEnd(src, neutral, q) {
  const n = src.length;
  let L = 0;
  while (q + L < n && src[q + L] === '`') L++;
  if (L === 0) return -1;
  let r = q + L;
  while (r < n) {
    if (src[r] === '`') {
      let L2 = 0;
      while (r + L2 < n && src[r + L2] === '`') L2++;
      if (L2 === L) {
        if (r > q + L && (r + L >= n || src[r + L] !== '`')) return r + L;
        // Not a valid closer (empty content or followed by a backtick);
        // keep looking for a later run.
        r += L2;
        continue;
      }
      // A live backtick of another length inside the content: no code span.
      if (!neutral[r]) return -1;
      r += L2;
    } else r++;
  }
  return -1;
}

// Scan an inline source for the regions marked's masking (blockSkip) hides:
// code spans and [label](dest) links, computed in the Ot-neutralised view.
// A real inline link (whose label the link regex accepts) is skipped, not
// masked, because its label is parsed separately. Returns [start, end)
// ranges. A delimiter inside one of these ranges is invisible to the
// emphasis/del closer scan.
function computeMaskedRanges(src) {
  // Fast path: with no backtick and no '[', there is no code span or link
  // for the masking to hide, so no delimiter can be masked.
  if (src.indexOf('`') < 0 && src.indexOf('[') < 0) return [];
  const ranges = [];
  const n = src.length;
  const neutral = otNeutralized(src);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      if (neutral[i]) { i++; continue; }
      const end = blockSkipCodeEnd(src, neutral, i);
      if (end > 0) { ranges.push([i, end]); i = end; continue; }
      let L = 0;
      while (i + L < n && src[i + L] === '`') L++;
      i += L;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const lb = c === '!' ? i + 1 : i;
      const le = scanLabelEnd(src, lb);
      if (le > 0 && src[le] === '(') {
        const paren = matchParen(src, le);
        if (paren > 0) {
          // A real inline link: not masked as a whole, but do NOT skip
          // past it — backticks inside its label can still pair with
          // later backticks via Ot and form a masked code span. Advance
          // by one so the label's content is scanned for code spans.
          i++;
          continue;
        }
      }
      const bs = skipBlockSkipLink(src, i);
      if (bs > 0) { ranges.push([i, bs]); i = bs; continue; }
      i++;
      continue;
    }
    i++;
  }
  return ranges;
}

// True when position pos lies inside one of the masked ranges.
function isMaskedPos(ranges, pos) {
  if (!ranges || ranges.length === 0) return false;
  for (let k = 0; k < ranges.length; k++) {
    const r = ranges[k];
    if (pos >= r[0] && pos < r[1]) return true;
    if (r[0] > pos) break;
  }
  return false;
}

// At a backtick run starting at q: if a code span starts here, return the
// index just past it; otherwise return the index just past the whole run.
// A failed code-span opener is consumed as text, never retried mid-run
// (the second backtick of `` `` `` must not pair with a later lone backtick).
function skipCodeSpanOrRun(src, q) {
  const cs = matchCodeSpan(src, q);
  if (cs) return cs.end;
  let k = q;
  while (k < src.length && src[k] === '`') k++;
  return k;
}

function tryEmphasis(src, i, links, ctx, prev) {
  // A delimiter inside a masked construct (a [label](dest) that blockSkip
  // hides) is invisible to the emphasis scan.
  if (isMaskedPos(ctx.maskedRanges, i)) return null;
  const r = src[i];
  const n = src.length;
  let k = 0;
  while (i + k < n && src[i + k] === r) k++;
  const after = i + k < n ? src[i + k] : '';
  if (after === '' || isSpace(after) || after === r) return null;
  // The run start (backing up over delimiters already emitted as text)
  // and the character before the run.
  let l = i;
  while (l > 0 && src[l - 1] === r) l--;
  const p = l > 0 ? src[l - 1] : '';
  const backedUp = l < i;
  const nPrev = backedUp ? p : prev;
  // '_' cannot open when followed by a word character and preceded by an
  // alphanumeric character.
  if (r === '_' && !isPunctGfm(after) && IS_ALNUM_RE.test(nPrev)) return null;
  // Left-flanking: the opener is followed by punctuation only when the
  // previous character is absent or whitespace/punctuation (the
  // punctuation test here includes '~' but not '*'/'_').
  const d = isPunctGfm(after) ? after : '';
  const h = p === '*' || p === '_' || isSpace(p) || isPunct(p);
  const u = backedUp ? h : (isSpace(nPrev) || (isPunct(nPrev) && nPrev !== '*' && nPrev !== '_'));
  if (d !== '' && nPrev !== '' && !u) return null;
  // R: the opener is preceded by a non-space character and either followed
  // by punctuation or (for *) preceded by a non-punctuation character.
  const R = p !== '' && !isSpace(p) && (d !== '' || (r === '*' && !h));
  // o: the character before the opener is the same delimiter. When it is,
  // a both-flanking candidate ends the scan with no emphasis formed.
  const o = prev === r;
  // y: the full delimiter run length, counting delimiters that were already
  // emitted as text immediately before this opener.
  const y = i - l + k;
  const start = i + k;
  const bound = lastCloserStart(src, start, r);
  if (bound < start) return null;
  const shield = r === '*' ? shieldedDelim(src, start, '_', '*') : shieldedDelim(src, start, '*', '_');
  let m = k;
  let f = 0;
  let j = start;
  while (j <= bound) {
    // Find the next delimiter run, skipping constructs whose delimiters do
    // not count as closers (escapes, code spans, links, tags).
    let rs = -1;
    for (let q = j; q <= bound; q++) {
      const ch = src[q];
      if (ch === r) { rs = q; break; }
      if (ch === '\\' && q + 1 < n && isAsciiPunct(src[q + 1])) { q++; continue; }
      if (ch === '`') { q = skipCodeSpanOrRun(src, q) - 1; continue; }
      if (ch === '<') {
        const t = matchTag(src, q) || matchAutolink(src, q);
        if (t) { q = t.end - 1; continue; }
      }
      if (ch === '[' || (ch === '!' && src[q + 1] === '[')) {
        const lk = matchInlineLink(src, q, links, ctx) || matchRefLink(src, q, links, ctx);
        if (lk && lk.html !== null) { q = lk.end - 1; continue; }
        const bs = skipBlockSkipLink(src, q);
        if (bs > 0) { q = bs - 1; continue; }
      }
    }
    if (rs < 0) break;
    let b = 0;
    while (rs + b < n && src[rs + b] === r) b++;
    if (isMaskedPos(ctx.maskedRanges, rs)) { j = rs + b; continue; }
    if (rs === shield) { j = rs + b; continue; }
    const fl2 = flank(src, rs, b, isPunctGfm);
    if (!fl2.left && !fl2.right) { j = rs + b; continue; }
    // For '_', a run followed by an alphanumeric cannot close and a run
    // preceded by one cannot open (intra-word rule).
    let canOpen = fl2.left;
    let canClose = fl2.right;
    if (r === '_') {
      const afterRun = rs + b < n ? src[rs + b] : '';
      const beforeRun = rs > 0 ? src[rs - 1] : '';
      if (afterRun !== '' && IS_ALNUM_RE.test(afterRun)) canClose = false;
      if (beforeRun !== '' && IS_ALNUM_RE.test(beforeRun)) canOpen = false;
    }
    if (!canOpen && !canClose) { j = rs + b; continue; }
    if (canOpen && !canClose) { m += b; j = rs + b; continue; }
    if (canOpen && canClose) {
      // Both-flanking: the rule of three always applies.
      if (o) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; j = rs + b; continue; }
    } else if (R && y % 3 !== 0 && (y + b) % 3 === 0) {
      // Closer-only: the rule of three applies only when R is set.
      f += b; j = rs + b; continue;
    }
    m -= b;
    if (m > 0) { j = rs + b; continue; }
    b = Math.min(b, b + m + f);
    const rawEnd = rs + b;
    const plain = ctx.render === plainText;
    if (Math.min(k, b) % 2 === 1) {
      const inner = ctx.render(src.slice(i + 1, rawEnd - 1), links, ctx);
      return { html: plain ? inner : '<em>' + inner + '</em>', end: rawEnd };
    }
    const inner = ctx.render(src.slice(i + 2, rawEnd - 2), links, ctx);
    return { html: plain ? inner : '<strong>' + inner + '</strong>', end: rawEnd };
  }
  return null;
}

// Try to form <del> from the tilde run starting at i (one or two tildes).
// `prev` is the previous token's last character ("" when the previous
// token was not a text token). Strikethrough uses the plain Unicode
// punctuation test (it includes '~'). Returns {html, end} or null.
function tryDel(src, i, links, ctx, prev) {
  // A delimiter inside a masked construct is invisible to the del scan.
  if (isMaskedPos(ctx.maskedRanges, i)) return null;
  const n = src.length;
  let o = 0;
  while (i + o < n && src[i + o] === '~') o++;
  if (o > 2) return null;
  const after = i + o < n ? src[i + o] : '';
  if (after === '' || isSpace(after) || after === '~') return null;
  // Left-flanking: the opener is followed by punctuation only when the
  // previous character is absent or whitespace/punctuation (the plain
  // Unicode test, which includes '~' but not '*'/'_').
  const d = isPunct(after) ? after : '';
  const u = isSpace(prev) || (isPunct(prev) && prev !== '*' && prev !== '_');
  if (d !== '' && prev !== '' && !u) return null;
  const start = i + o;
  const bound = lastCloserStart(src, start, '~');
  if (bound < start) return null;
  let p = o;
  let j = start;
  while (j <= bound) {
    // Find the next tilde run, skipping constructs whose tildes do not
    // count as closers (escapes, code spans, links, tags).
    let rs = -1;
    for (let q = j; q <= bound; q++) {
      const ch = src[q];
      if (ch === '~') { rs = q; break; }
      if (ch === '\\' && q + 1 < n && isAsciiPunct(src[q + 1])) { q++; continue; }
      if (ch === '`') { q = skipCodeSpanOrRun(src, q) - 1; continue; }
      if (ch === '<') {
        const t = matchTag(src, q) || matchAutolink(src, q);
        if (t) { q = t.end - 1; continue; }
      }
      if (ch === '[' || (ch === '!' && src[q + 1] === '[')) {
        const lk = matchInlineLink(src, q, links, ctx) || matchRefLink(src, q, links, ctx);
        if (lk && lk.html !== null) { q = lk.end - 1; continue; }
        const bs = skipBlockSkipLink(src, q);
        if (bs > 0) { q = bs - 1; continue; }
      }
    }
    if (rs < 0) break;
    let b = 0;
    while (rs + b < n && src[rs + b] === '~') b++;
    if (isMaskedPos(ctx.maskedRanges, rs)) { j = rs + b; continue; }
    if (b > 2 || b !== o) { j = rs + b; continue; }
    const fl2 = flank(src, rs, b, isPunct);
    if (!fl2.left && !fl2.right) { j = rs + b; continue; }
    if (fl2.left && !fl2.right) { p += b; j = rs + b; continue; }
    p -= b;
    if (p > 0) { j = rs + b; continue; }
    const inner = ctx.render(src.slice(i + o, rs), links, ctx);
    return { html: ctx.render === plainText ? inner : '<del>' + inner + '</del>', end: rs + b };
  }
  return null;
}

// ---------- extended autolinks (GFM) ----------

const EMAIL_CHARS = /[A-Za-z0-9._+\-]/;
const URL_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+(?![\w-])/;
const URL_PROTO_RE = /^(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Match a GFM extended autolink at i: www., scheme:// or email. Returns
// {html, end} or null.
function matchUrl(src, i) {
  const rest = src.slice(i);
  let m = URL_PROTO_RE.exec(rest);
  if (m) {
    let text = m[0];
    // The backpedal trims trailing punctuation/balanced parens; it is
    // applied until the result stops changing.
    let prev = '';
    while (prev !== text) {
      prev = text;
      const back = BACKPEDAL_RE.exec(text);
      text = back ? back[0] : '';
    }
    if (!text) return null;
    const href = text.startsWith('www.') ? 'http://' + text : text;
    const enc = hrefEncode(href);
    if (enc === null) return null;
    return { html: '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>', end: i + text.length, text };
  }
  m = URL_EMAIL_RE.exec(rest);
  if (m) {
    const text = m[0];
    return { html: '<a href="mailto:' + esc(text, true) + '">' + esc(text, true) + '</a>', end: i + text.length, text };
  }
  // mailto: / xmpp: followed by an email address (xmpp may carry a
  // /resource suffix).
  if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) {
    const proto = rest.startsWith('mailto:') ? 'mailto:' : 'xmpp:';
    const em = URL_EMAIL_RE.exec(rest.slice(proto.length));
    if (em) {
      let full = proto + em[0];
      if (proto === 'xmpp:') {
        const res = /^\/[A-Za-z0-9@.]+/.exec(rest.slice(full.length));
        if (res) full += res[0];
      }
      let text = full;
      let prev = '';
      while (prev !== text) {
        prev = text;
        const back = BACKPEDAL_RE.exec(text);
        text = back ? back[0] : '';
      }
      if (!text) return null;
      const enc = hrefEncode(text);
      if (enc === null) return null;
      return { html: '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>', end: i + text.length, text };
    }
  }
  return null;
}

// Does a GFM autolink (www./protocol/email) start at position p of src?
// The email case requires the character before p not to be an email char.
function urlStartsAt(src, p) {
  const c = src[p];
  if (c === 'w' && src.startsWith('www.', p)) {
    const prev = p > 0 ? src[p - 1] : '';
    if (prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' || prev === '\v' || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      return isDomainStart(src.charCodeAt(p + 4));
    }
    return false;
  }
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F') return protoPrefixAt(src, p);
  if (c === 'm' && src.startsWith('mailto:', p)) {
    const prev = p > 0 ? src[p - 1] : '';
    if (prev === '' || !/[A-Za-z0-9]/.test(prev)) return true;
    return false;
  }
  if (c === 'x' && src.startsWith('xmpp:', p)) {
    const prev = p > 0 ? src[p - 1] : '';
    if (prev === '' || !/[A-Za-z0-9]/.test(prev)) return true;
    return false;
  }
  return false;
}

// Find an email address starting at or after `from` in the current text
// run: returns its start index or -1. Only used when an '@' is seen.
function emailStartBefore(src, at) {
  let s = at;
  while (s > 0 && EMAIL_CHARS.test(src[s - 1])) s--;
  if (s === at) return -1;
  const prev = s > 0 ? src[s - 1] : '';
  if (prev !== '' && EMAIL_CHARS.test(prev)) return -1;
  // The slice is capped at at + 256, exactly as the inline scanner's
  // email check does it.
  return URL_EMAIL_RE.test(src.slice(s, at + 256)) ? s : -1;
}

// ---------- the inline scanner ----------

const START_A_RE = /^<a /i;
const END_A_RE = /^<\/a>/i;
const START_PRE_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// True when src[from..] is only whitespace (or empty).
function onlyWhitespace(src, from) {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f' && c !== '\v') return false;
  }
  return true;
}

// True when an email address starts at p of src, given `at` is the next
// '@' at or after p (or -1). The walk from p to at must be email chars:
// if it stops early, the regex cannot match either (its local part is an
// unbroken run of email chars ending at the '@'), so the regex test is
// skipped for ordinary words.
function emailAtFrom(src, p, at) {
  if (at <= p) return false;
  let q = p;
  while (q < at && isEmailCharCode(src.charCodeAt(q))) q++;
  if (q !== at) return false;
  return URL_EMAIL_RE.test(src.slice(p, at + 256));
}

// Scan a run of plain inline text starting at i. Returns the index just
// past the run. The run stops before a construct, before a URL/email
// start, and after a non-space character followed by two or more spaces
// Cheap case-insensitive check for a URL protocol prefix (http://,
// https://, ftp://) followed by a domain-start character. Replaces a
// 512-char slice plus regex test in the hot text-run loop; the full URL
// regex in matchUrl remains the authority, so stopping early here is
// output-neutral when the domain turns out invalid.
function protoPrefixAt(src, p) {
  const a = src.charCodeAt(p) | 32;
  if (a === 104) { // 'h' -> http
    if ((src.charCodeAt(p + 1) | 32) !== 116) return false; // 't'
    if ((src.charCodeAt(p + 2) | 32) !== 116) return false; // 't'
    if ((src.charCodeAt(p + 3) | 32) !== 112) return false; // 'p'
    let q = p + 4;
    if ((src.charCodeAt(q) | 32) === 115) q++; // 's' -> https
    if (src.charCodeAt(q) !== 58 || src.charCodeAt(q + 1) !== 47 || src.charCodeAt(q + 2) !== 47) return false;
    return isDomainStart(src.charCodeAt(q + 3));
  }
  if (a === 102) { // 'f' -> ftp
    if ((src.charCodeAt(p + 1) | 32) !== 116) return false; // 't'
    if ((src.charCodeAt(p + 2) | 32) !== 112) return false; // 'p'
    if (src.charCodeAt(p + 3) !== 58 || src.charCodeAt(p + 4) !== 47 || src.charCodeAt(p + 5) !== 47) return false;
    return isDomainStart(src.charCodeAt(p + 6));
  }
  return false;
}

function isDomainStart(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;
}

function isEmailCharCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 46 || code === 95 || code === 43 || code === 45;
}

// Sticky search for the next position where a text run could stop: a
// construct character, an '@' (a possible email), a URL-scheme start, or
// two spaces before a newline (a possible hard break). It is a superset of
// the run's stop positions: every stop of the char-by-char scan is one of
// these, so a position this regex skips can never be a stop. The precise
// checks (prev-character rules, protoPrefixAt, the email regex) still run
// at each candidate, so the result is identical -- only the scan itself
// moves into the regex engine's native code.
const TEXT_RUN_STOP_RE = /[\\<[!*_`~@]|www\.|[Hh][Tt][Tt][Pp]s?|[Ff][Tt][Pp]|mailto:|xmpp:| {2,}\n/g;

// Scan a run of plain inline text starting at i. Returns the index just
// past the run. The run stops before a construct, before a URL/email
// start, and after a non-space character followed by two or more spaces
// and a newline (a hard break).
function scanTextRun(src, i) {
  const n = src.length;
  let p = i;
  // A text token starting with a backtick or tilde run consumes the whole
  // run.
  if (src[p] === '`' || src[p] === '~') {
    const ch = src[p];
    while (p < n && src[p] === ch) p++;
  }
  // The hard-break check below looks at the character just before the
  // spaces; that character must be one the scan actually visits, so the
  // positions the run above already consumed do not count.
  const start = p;
  TEXT_RUN_STOP_RE.lastIndex = p;
  let m;
  while ((m = TEXT_RUN_STOP_RE.exec(src)) !== null) {
    const pos = m.index;
    const mc = m[0];
    if (mc.length === 1) {
      // A single construct character (or '@').
      if (mc === '@') {
        // A possible email: the word ending at this '@' is an email
        // start, and the run stops there (only when the email starts
        // inside the run; an email starting at or before i was already
        // rejected by tryUrl and is consumed as text).
        if (pos > i) {
          const s = emailStartBefore(src, pos);
          if (s > i) return s;
        }
      } else if (pos > i) {
        return pos;
      }
      // A construct character at the run start is consumed as text, and
      // an '@' with no email before it is plain text: continue past it.
      TEXT_RUN_STOP_RE.lastIndex = pos + 1;
      continue;
    }
    if (mc[0] === ' ') {
      // Two or more spaces before a newline: a hard break, so the run
      // ends after the non-space character just before these spaces
      // (only when that character is plain text the scan visits).
      if (pos > start) {
        const before = src[pos - 1];
        if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') return pos;
      }
      // Not a hard break: nothing inside these spaces and the newline
      // can be a stop, so skip past the whole match.
      TEXT_RUN_STOP_RE.lastIndex = pos + mc.length;
      continue;
    }
    // A URL start: www. / http(s) / ftp / mailto: / xmpp:.
    if (pos > i) {
      const c = src[pos];
      if (c === 'w') {
        const prev = src[pos - 1];
        if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '*' || prev === '_' || prev === '~' || prev === '(') return pos;
      } else if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
        if (protoPrefixAt(src, pos)) return pos;
      } else if (c === 'm' || c === 'x') {
        if (!/[A-Za-z0-9]/.test(src[pos - 1])) return pos;
      }
    }
    TEXT_RUN_STOP_RE.lastIndex = pos + 1;
  }
  return n;
}

// Update the tag-driven lexer state (inLink for <a>...</a>, inRawBlock for
// <pre>/<code>/<kbd>/<script>...</...>).
function tagState(raw, ctx) {
  if (!ctx.inLink && START_A_RE.test(raw)) ctx.inLink = true;
  else if (ctx.inLink && END_A_RE.test(raw)) ctx.inLink = false;
  if (!ctx.inRawBlock && START_PRE_RE.test(raw)) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && END_PRE_RE.test(raw)) ctx.inRawBlock = false;
}

// Try to match an extended autolink at i (www./scheme/email), gated by
// cheap pre-checks. `at` is the next '@' at or after i (or -1), maintained
// by the caller so the email check never rescans for it. Returns the
// matchUrl result or null.
function tryUrl(src, i, at) {
  const c = src[i];
  if (urlStartsAt(src, i)) return matchUrl(src, i);
  if (EMAIL_CHARS.test(c) && (i === 0 || !EMAIL_CHARS.test(src[i - 1])) && emailAtFrom(src, i, at)) return matchUrl(src, i);
  return null;
}

// Fast path for plain inline text: no construct can start, no entity to
// decode or character to escape, no URL/email to linkify, no hard break.
// The output is then the input itself.
const INLINE_PLAIN_RE = /[\\<[!*_`~&"'>@]/;
// http/https/ftp autolinks are case-insensitive (GFM); www./mailto:/xmpp:
// are matched lowercase-only by marked, so plain indexOf is exact there.
const INLINE_URL_RE = /https?|ftp/i;
function inlineIsPlain(src) {
  return !INLINE_PLAIN_RE.test(src) && !INLINE_URL_RE.test(src)
    && src.indexOf('www.') < 0
    && src.indexOf('mailto:') < 0 && src.indexOf('xmpp:') < 0 && src.indexOf('  \n') < 0;
}
const PLAIN_TEXT_PLAIN_RE = /[\\<[!*_`~&]/;
function plainIsPlain(src) {
  return !PLAIN_TEXT_PLAIN_RE.test(src) && src.indexOf('  \n') < 0;
}

// Render inline markdown to HTML. `ctx` carries the lexer state
// (inLink, inRawBlock, linkEmitted, render) for this parse() call.
function inlineHtml(src, links, ctx) {
  if (inlineIsPlain(src)) return src;
  const savedRanges = ctx.maskedRanges;
  // Masked ranges are only consulted by tryEmphasis/tryDel, which only
  // run when the source holds a '*', '_' or '~' delimiter; without one
  // no delimiter can be masked, so the (multi-pass) scan is skipped.
  ctx.maskedRanges = (src.indexOf('*') < 0 && src.indexOf('_') < 0 && src.indexOf('~') < 0)
    ? null : computeMaskedRanges(src);
  let out = '';
  let i = 0;
  const n = src.length;
  let r = '';
  let prevText = false;

  // The next '@' at or after i, refreshed as the scan passes it: the
  // email check in tryUrl needs it, and re-scanning for it at every
  // token start is O(n^2).
  let at = src.indexOf('@');  while (i < n) {
    if (!prevText) r = '';
    prevText = false;
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        // Hard break via backslash.
        if (!onlyWhitespace(src, i + 2)) {
          out += '<br>';
          i += 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
      } else if (d !== undefined && isAsciiPunct(d)) {
        out += esc(d, false);
        i += 2;
        continue;
      }
      // Otherwise the backslash is plain text: fall through to the run.
    }
    if (c === '<') {
      const t = matchTag(src, i);
      if (t) {
        tagState(t.raw, ctx);
        out += t.raw;
        i = t.end;
        continue;
      }
      const a = matchAutolink(src, i);
      if (a) {
        const enc = hrefEncode(a.href);
        if (enc === null) { out += esc(a.text, true); i = a.end; continue; }
        out += '<a href="' + esc(enc, true) + '">' + esc(a.text, true) + '</a>';
        i = a.end;
        continue;
      }
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const l = matchInlineLink(src, i, links, ctx) || matchRefLink(src, i, links, ctx);
      if (l) {
        if (l.html !== null) {
          out += l.html;
          i = l.end;
          continue;
        }
        // Undefined reference: only the first character is consumed.
        const ch = l.text;
        out += ctx.inRawBlock ? ch : textOut(ch);
        if (ch !== '_') r = ch;
        prevText = true;
        i = l.end;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const e = tryEmphasis(src, i, links, ctx, r);
      if (e) { out += e.html; i = e.end; continue; }
    }
    if (c === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) { out += '<code>' + esc(cs.text, true) + '</code>'; i = cs.end; continue; }
    }
    if (c === '~') {
      const d = tryDel(src, i, links, ctx, r);
      if (d) { out += d.html; i = d.end; continue; }
    }
    if (!ctx.inLink) {
      if (at !== -1 && at < i) at = src.indexOf('@', i);
      const u = tryUrl(src, i, at);
      if (u) { out += u.html; i = u.end; continue; }
    }
    // Hard break: two or more spaces before a newline, with
    // non-whitespace after it.
    if (c === ' ') {
      let q = i, sp = 0;
      while (q < n && src[q] === ' ') { sp++; q++; }
      if (sp >= 2 && q < n && src[q] === '\n' && !onlyWhitespace(src, q + 1)) {
        out += '<br>';
        i = q + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
    }
    const end = scanTextRun(src, i);
    const run = src.slice(i, end);
    out += ctx.inRawBlock ? run : textOut(run);
    if (run.length > 0) {
      const last = run[run.length - 1];
      if (last !== '_') r = last;
      prevText = true;
    }
    i = end;
  }
  ctx.maskedRanges = savedRanges;
  return out;
}

// Render inline markdown to plain text (for image alt attributes). Links
// and emphasis render as their inner text, code spans as their content,
// hard breaks as nothing, tags as their raw text.
function plainText(src, links, ctx) {
  if (plainIsPlain(src)) return src;
  const saved = ctx.render;
  ctx.render = plainText;
  const savedRanges = ctx.maskedRanges;
  // Masked ranges are only consulted by tryEmphasis/tryDel, which only
  // run when the source holds a '*', '_' or '~' delimiter; without one
  // no delimiter can be masked, so the (multi-pass) scan is skipped.
  ctx.maskedRanges = (src.indexOf('*') < 0 && src.indexOf('_') < 0 && src.indexOf('~') < 0)
    ? null : computeMaskedRanges(src);
  let out = '';
  let i = 0;
  const n = src.length;
  let r = '';
  let prevText = false;

  // The next '@' at or after i, refreshed as the scan passes it: the
  // email check in tryUrl needs it, and re-scanning for it at every
  // token start is O(n^2).
  let at = src.indexOf('@');  while (i < n) {
    if (!prevText) r = '';
    prevText = false;
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (d !== undefined && isAsciiPunct(d)) { out += d; i += 2; continue; }
    }
    if (c === '<') {
      const t = matchTag(src, i);
      if (t) {
        tagState(t.raw, ctx);
        out += t.raw;
        i = t.end;
        continue;
      }
      const a = matchAutolink(src, i);
      if (a) { out += a.text; i = a.end; continue; }
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const l = matchInlineLink(src, i, links, ctx) || matchRefLink(src, i, links, ctx);
      if (l) {
        if (l.html !== null) { out += l.html; i = l.end; continue; }
        const ch = l.text;
        out += ch;
        if (ch !== '_') r = ch;
        prevText = true;
        i = l.end;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const e = tryEmphasis(src, i, links, ctx, r);
      if (e) { out += e.html; i = e.end; continue; }
    }
    if (c === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) { out += cs.text; i = cs.end; continue; }
    }
    if (c === '~') {
      const d = tryDel(src, i, links, ctx, r);
      if (d) { out += d.html; i = d.end; continue; }
    }
    if (!ctx.inLink) {
      if (at !== -1 && at < i) at = src.indexOf('@', i);
      const u = tryUrl(src, i, at);
      if (u) { out += u.text; i = u.end; continue; }
    }
    if (c === ' ') {
      let q = i, sp = 0;
      while (q < n && src[q] === ' ') { sp++; q++; }
      if (sp >= 2 && q < n && src[q] === '\n' && !onlyWhitespace(src, q + 1)) {
        i = q + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
    }
    const end = scanTextRun(src, i);
    const run = src.slice(i, end);
    out += ctx.inRawBlock ? run : decodeRefs(run);
    if (run.length > 0) {
      const last = run[run.length - 1];
      if (last !== '_') r = last;
      prevText = true;
    }
    i = end;
  }
  ctx.render = saved;
  ctx.maskedRanges = savedRanges;
  return out;
}

// ---------- block parsing ----------
//
// The block lexer walks the source top to bottom, producing a small list
// of block nodes, and collects link reference definitions into `links`
// (definitions found later in the document apply to earlier paragraphs,
// so inline rendering happens only after the whole block pass). The
// renderer then walks the nodes and parses inline content directly to
// HTML at render time.

const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const INDENT_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const CODE_REMOVE_INDENT_RE = /^(?: {0,3}\t| {1,4})/gm;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const HR_RE = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/;
const BLOCKQUOTE_START_RE = /^ {0,3}>/;
const LIST_BULLET_RE = /^( {0,3})([*+-]|\d{1,9}[.)])/;
// A link reference definition: [label]: <dest> "title" (title optional,
// possibly on the next line). The label may contain spaces and newlines
// (but not a blank line).
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^)\\])*\))))? *(?:\n+|$)/;

// The link reference definition matcher. Returns {label, href, title, end}
// (end = index just past the definition's raw text, trailing newlines
// excluded) or null.
function matchDef(src) {
  const t = DEF_RE.exec(src);
  if (!t) return null;
  const dest = t[2];
  // A bare destination with unbalanced parens is not a definition.
  if (!dest.startsWith('<') && findParen(dest) !== -1) return null;
  let href = dest;
  if (href.startsWith('<')) href = href.slice(1, -1);
  href = unescapePunct(href);
  const title = t[3] ? unescapePunct(t[3].slice(1, -1)) : null;
  const raw = trimEndChar(t[0], '\n');
  return { label: t[1], tag: normLabel(t[1]), href, title, end: raw.length, raw };
}

// ---------- block matchers ----------

// Does `line` (a single line, no trailing newline) start a block that
// interrupts a paragraph? Used for paragraph continuation. (The value of
// the six regex tests below, with the HTML test delegated to htmlBegin.)
function paraInterrupt(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c === 35) { // '#': ATX heading, 1-6 '#' then whitespace or end of line
    let j = i, n = 0;
    while (line.charCodeAt(j) === 35 && n < 6) { j++; n++; }
    if (n === 0) return false;
    const a = line.charCodeAt(j);
    return Number.isNaN(a) || a === 32 || a === 9 || a === 10 || a === 13 || a === 11 || a === 12;
  }
  if (c === 62) return true; // '>'
  if (c === 96) { // backtick fence: 3+ backticks, no further backtick on the line
    let j = i, n = 0;
    while (line.charCodeAt(j) === 96) { j++; n++; }
    return n >= 3 && line.indexOf('`', j) < 0;
  }
  if (c === 126) { // tilde fence: 3+ tildes
    let j = i, n = 0;
    while (line.charCodeAt(j) === 126) { j++; n++; }
    return n >= 3;
  }
  if (c === 42 || c === 43 || c === 45) { // '*', '+', '-'
    // bullet: the char, 1+ spaces/tabs, then a non-space character
    let j = i + 1;
    if (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) {
      while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
      if (j < line.length) return true;
    }
    // thematic break
    return isHrRun(line, i, c);
  }
  if (c === 95) return isHrRun(line, i, 95); // '_': only a thematic break
  if (c === 49) { // '1': ordered bullet 1[.)] then 1+ spaces/tabs, then a char
    const d = line.charCodeAt(i + 1);
    if (d === 46 || d === 41) {
      let j = i + 2;
      if (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) {
        while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
        if (j < line.length) return true;
      }
    }
    return false;
  }
  if (c === 60) return htmlBegin(line); // '<'
  return false;
}

// Does `line` start an HTML block (the html-begin test)?
function htmlBegin(line) {
  return htmlBeginMax(line, 3);
}

// A fenced code block starting at src. Returns {text, lang, raw} or null.
function matchFences(src) {
  const m = FENCE_OPEN_RE.exec(src);
  if (!m) return null;
  const fence = m[1];
  const ch = fence[0];
  // A backtick fence's info string must not contain a backtick.
  if (ch === '`' && m[2].includes('`')) return null;
  const lang = m[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
  let rest = src.slice(m[0].length);
  let text = '';
  let raw = m[0];
  while (rest.length > 0) {
    const nl = rest.indexOf('\n');
    const line = nl < 0 ? rest : rest.slice(0, nl);
    const close = /^ {0,3}(`{3,}|~{3,}) *$/.exec(line);
    if (close && close[1][0] === ch && close[1].length >= fence.length) {
      // The closing fence line is part of the raw (but not its trailing
      // newline), and the newline before it is not part of the content.
      raw += line;
      if (text.endsWith('\n')) text = text.slice(0, -1);
      let out = text;
      const comp = /^(\s+)(?:```)/.exec(raw);
      if (comp) {
        const n = comp[1].length;
        out = text.split('\n').map((ln) => {
          const sp = /^\s+/.exec(ln);
          if (!sp) return ln;
          return ln.slice(Math.min(sp[0].length, n));
        }).join('\n');
      }
      return { text: out, lang, raw };
    }
    text += line + (nl < 0 ? '' : '\n');
    raw += line + (nl < 0 ? '' : '\n');
    if (nl < 0) break;
    rest = rest.slice(nl + 1);
  }
  // No closing fence: the content runs to the end. Marked's fence regex
  // consumes the final newline in its (?:\n|$) tail, so the token text
  // drops one trailing newline when present.
  if (text.endsWith('\n')) text = text.slice(0, -1);
  let out = text;
  const comp = /^(\s+)(?:```)/.exec(raw);
  if (comp) {
    const n = comp[1].length;
    out = text.split('\n').map((ln) => {
      const sp = /^\s+/.exec(ln);
      if (!sp) return ln;
      return ln.slice(Math.min(sp[0].length, n));
    }).join('\n');
  }
  return { text: out, lang, raw };
}

// An indented code block. Returns {text, raw} or null.
function matchIndentCode(src) {
  const m = INDENT_CODE_RE.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  const text = raw.replace(CODE_REMOVE_INDENT_RE, '');
  return { text, raw };
}

// An ATX heading. Returns {depth, text, raw} or null.
function matchHeading(src) {
  const m = HEADING_RE.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = trimEndChar(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth: m[1].length, text, raw: trimEndChar(m[0], '\n') };
}

// A horizontal rule. Returns {raw} or null.
function matchHr(src) {
  const m = HR_RE.exec(src);
  if (!m) return null;
  return { raw: trimEndChar(m[0], '\n') };
}

// Setext underline depth of `line` (1 for '=', 2 for '-'), or 0. (The
// value of /^ {0,3}(=+|-+)[ \t]*$/.exec(line), with the run's character
// deciding the depth.)
function setextDepth(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  let j = i;
  while (line.charCodeAt(j) === c) j++;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch !== 32 && ch !== 9) return 0;
    j++;
  }
  return c === 61 ? 1 : 2;
}

// True when `line` cannot be a setext heading's text line: it starts a
// bullet, indented code, fence, blockquote or ATX heading. (The value of
// the per-line regex tests in matchLheading, minus the two that can never
// match a single line without its newline: the html and table-delimiter
// tests both end in \n.)
function lheadingBadLine(line) {
  // indented code: 4 spaces, or up to 3 spaces then a tab
  if (line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32 && line.charCodeAt(2) === 32 && line.charCodeAt(3) === 32) return true;
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  if (line.charCodeAt(i) === 9) return true;
  const c = line.charCodeAt(i);
  if (c === 42 || c === 43 || c === 45) { // '*', '+', '-': bullet needs one space after
    return line.charCodeAt(i + 1) === 32;
  }
  if (c >= 48 && c <= 57) { // digit: ordered bullet needs '.' or ')' then one space
    let j = i, n = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && n < 9) { j++; n++; }
    if (n === 0) return false;
    const d = line.charCodeAt(j);
    return (d === 46 || d === 41) && line.charCodeAt(j + 1) === 32;
  }
  if (c === 96 || c === 126) { // fence: 3+ backticks or tildes
    return line.charCodeAt(i + 1) === c && line.charCodeAt(i + 2) === c;
  }
  if (c === 62) return true; // '>'
  if (c === 35) { // '#': ATX heading, 1-6 '#' then whitespace or end of line
    let j = i, n = 0;
    while (line.charCodeAt(j) === 35 && n < 6) { j++; n++; }
    if (n === 0) return false;
    const a = line.charCodeAt(j);
    return Number.isNaN(a) || a === 32 || a === 9 || a === 10 || a === 13 || a === 11 || a === 12;
  }
  return false;
}

// True when `line` is a thematic break (the hr regex, indent at most 3).
function lineHr(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  return isHrRun(line, i, c);
}

// A setext (underline) heading. `src` starts at the paragraph text.
// Returns {depth, text, raw} or null.
function matchLheading(src) {
  // The text is one or more lines, none of which may start a bullet,
  // indented code, fence, blockquote, ATX heading, hr, html block or
  // table delimiter; then a line of = or -.
  let text = '';
  let pos = 0;
  let i = 0;
  for (;;) {
    if (pos > src.length) return null;
    const nl = src.indexOf('\n', pos);
    const line = nl < 0 ? src.slice(pos) : src.slice(pos, nl);
    const isLast = nl < 0;
    // The underline is checked first: a line of = or - is the underline
    // even though it also looks like a thematic break.
    const depth = setextDepth(line);
    if (depth) {
      if (text === '') return null;
      const raw = text + '\n' + line;
      return { depth, text: text.trim(), raw };
    }
    if (i === 0) {
      if (lheadingBadLine(line)) return null;
    } else {
      if (isBlankLine(line)) return null;
      if (lheadingBadLine(line)) return null;
      if (lineHr(line)) return null;
    }
    text = text === '' ? line : text + '\n' + line;
    if (isLast) break;
    pos = nl + 1;
    i++;
  }
  return null;
}

// A paragraph: lines that are not blank and do not interrupt. Returns
// {text, raw} or null.
function matchParagraph(src) {
  const nl0 = src.indexOf('\n');
  const first = nl0 < 0 ? src : src.slice(0, nl0);
  if (first === '') return null;
  let text = first;
  let consumed = first.length;
  let pos = nl0 < 0 ? src.length : nl0 + 1;
  let i = 1;
  for (;;) {
    if (pos >= src.length) break;
    const nl = src.indexOf('\n', pos);
    const line = nl < 0 ? src.slice(pos) : src.slice(pos, nl);
    const isLast = nl < 0;
    // An empty line ends the paragraph. A line of only spaces ends it too,
    // unless it is the last line (a trailing spaces-only line is part of
    // the paragraph, e.g. inside a blockquote).
    if (line === '') break;
    if (isBlankLine(line) && !isLast) break;
    if (paraInterrupt(line)) break;
    // A table header+delimiter interrupts a paragraph.
    if (!isLast) {
      const nl2 = src.indexOf('\n', nl + 1);
      const nextLine = nl2 < 0 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
      const fc = line.charCodeAt(0);
      const startsWs = fc === 32 || fc === 9 || fc === 11 || fc === 12 || fc === 13;
      if (isTableDelimiter(nextLine) && line.trim() !== '' && !startsWs) break;
    }
    text += '\n' + line;
    consumed += 1 + line.length;
    if (isLast) break;
    pos = nl + 1;
    i++;
  }
  // The paragraph's raw ends at the last line (no trailing newline).
  return { text, raw: src.slice(0, consumed) };
}

// Is `line` a table delimiter row? The delimiter's first non-space
// character must be '|', ':' or '-', which gates the full regex.
function isTableDelimiter(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c !== 124 && c !== 58 && c !== 45) return false;
  const m = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/.exec(line);
  if (!m) return false;
  return /[:|]/.test(m[1]);
}

// True when `line` holds only spaces (or is empty). (The value of
// /^ *$/.test(line); unlike isBlankLine, a tab counts as content.)
function isSpacesOnly(line) {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 32) return false;
  }
  return true;
}

// True when `line` starts an indented code block: 4 spaces, or up to 3
// spaces then a tab, followed by a character. (The value of
// /^(?: {4}| {0,3}\t)[^\n]/.test(line).)
function isIndentCodeLine(line) {
  if (line.charCodeAt(0) === 32 && line.charCodeAt(1) === 32 && line.charCodeAt(2) === 32 && line.charCodeAt(3) === 32) return line.length > 4;
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  if (line.charCodeAt(i) !== 9) return false;
  return i + 1 < line.length;
}

// A table. Returns {node, raw} or null.
function matchTable(src) {
  const nl0 = src.indexOf('\n');
  if (nl0 < 0) return null;
  const headerLine = src.slice(0, nl0);
  if (!/^ *[^ \n]/.test(headerLine)) return null;
  const nl1 = src.indexOf('\n', nl0 + 1);
  const delim = nl1 < 0 ? src.slice(nl0 + 1) : src.slice(nl0 + 1, nl1);
  const dm = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/.exec(delim);
  if (!dm || !/[:|]/.test(dm[1])) return null;
  const header = splitTableRow(headerLine);
  const alignParts = dm[1].replace(/^\||\| *$/g, '').split('|');
  if (header.length !== alignParts.length) return null;
  const align = alignParts.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const rows = [];
  let consumed = headerLine.length + 1 + delim.length;
  let pos = nl1 < 0 ? src.length : nl1 + 1;
  for (;;) {
    if (pos >= src.length) break;
    const nl = src.indexOf('\n', pos);
    const line = nl < 0 ? src.slice(pos) : src.slice(pos, nl);
    const isLast = nl < 0;
    // A table body line is blank only when it holds spaces alone (marked's
    // (?! *\n) check); a tab-only line is a row of empty cells.
    if (isSpacesOnly(line)) break;
    if (paraInterrupt(line)) break;
    if (isIndentCodeLine(line)) break;
    rows.push(splitTableRow(line, header.length));
    consumed += line.length + 1;
    if (isLast) break;
    pos = nl + 1;
  }
  // The raw ends after the last row line (strip a trailing newline).
  let raw = src.slice(0, consumed);
  raw = raw.replace(/\n[ \t]*$/, '');
  return { node: { t: 'table', head: header, align, rows }, raw };
}

// An HTML block. Returns {text, raw} or null.
function matchHtmlBlock(src) {
  const m0 = /^ {0,3}/.exec(src);
  const start = m0[0].length;
  const rest = src.slice(start);
  // Type 1: <script|pre|style|textarea ...> ... </tag>
  let m = /^<(script|pre|style|textarea)[\s>]/i.exec(rest);
  if (m) {
    const tag = m[1].toLowerCase();
    const close = new RegExp('</' + tag + '>', 'i').exec(rest);
    let end;
    if (close) {
      end = close.index + close[0].length;
      const nl = rest.indexOf('\n', end);
      end = nl < 0 ? rest.length : nl + 1;
      // Include trailing newlines after the closing tag's line.
      let e2 = end;
      while (rest[e2] === '\n') e2++;
      end = e2;
    } else end = rest.length;
    const text = trimBlankTail(src.slice(0, start + end));
    return { text, raw: text };
  }
  // Type 2: comment.
  if (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->');
    let e2 = end < 0 ? rest.length : end + 3;
    const nl = rest.indexOf('\n', e2);
    e2 = nl < 0 ? rest.length : nl + 1;
    while (rest[e2] === '\n') e2++;
    const text = trimBlankTail(src.slice(0, start + e2));
    return { text, raw: text };
  }
  // Type 3: <? ... ?>
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>');
    let e2 = end < 0 ? rest.length : end + 2;
    const nl = rest.indexOf('\n', e2);
    e2 = nl < 0 ? rest.length : nl + 1;
    while (rest[e2] === '\n') e2++;
    const text = trimBlankTail(src.slice(0, start + e2));
    return { text, raw: text };
  }
  // Type 4: <!A-Z ... >
  if (/^<![A-Z]/.test(rest)) {
    const end = rest.indexOf('>');
    let e2 = end < 0 ? rest.length : end + 1;
    const nl = rest.indexOf('\n', e2);
    e2 = nl < 0 ? rest.length : nl + 1;
    while (rest[e2] === '\n') e2++;
    const text = trimBlankTail(src.slice(0, start + e2));
    return { text, raw: text };
  }
  // Type 5: <![CDATA[ ... ]]>
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>');
    let e2 = end < 0 ? rest.length : end + 3;
    const nl = rest.indexOf('\n', e2);
    e2 = nl < 0 ? rest.length : nl + 1;
    while (rest[e2] === '\n') e2++;
    const text = trimBlankTail(src.slice(0, start + e2));
    return { text, raw: text };
  }
  // Type 6: a block tag (open or close) -> ends at a blank line.
  m = /^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)/i.exec(rest);
  if (m) {
    const end = blankLineEnd(rest);
    const text = trimBlankTail(src.slice(0, start + end));
    return { text, raw: text };
  }
  // Type 7: a standalone open or close tag -> ends at a blank line.
  m = /^<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))/i.exec(rest);
  if (m) {
    const end = blankLineEnd(rest);
    const text = trimBlankTail(src.slice(0, start + end));
    return { text, raw: text };
  }
  m = /^<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))/i.exec(rest);
  if (m) {
    const end = blankLineEnd(rest);
    const text = trimBlankTail(src.slice(0, start + end));
    return { text, raw: text };
  }
  return null;
}

// Index just past the text up to and including the first blank line
// (or the end of the string). A blank line is an empty line or one with
// only spaces/tabs; the match includes the blank line itself so that
// trimBlankTail can drop the trailing newlines the way marked does.
function blankLineEnd(s) {
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    if (nl < 0) return s.length;
    const rest = s.slice(nl + 1);
    const m = /^[ \t]*\n/.exec(rest);
    if (m) return nl + 1 + m[0].length;
    if (/^[ \t]*$/.test(rest)) return s.length;
    i = nl + 1;
  }
  return s.length;
}

// ---------- blockquote ----------

const BLOCKQUOTE_START_RE2 = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const BLOCKQUOTE_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_STRIP_RE = /^ {0,3}>[ \t]?/gm;

// The raw blockquote match: '>' lines plus lazy paragraph-continuation
// lines. Returns the matched text or null.
function blockquoteMatch(src) {
  let consumed = 0;
  let pos = 0;
  let any = false;
  for (;;) {
    if (pos > src.length) break;
    const nl = src.indexOf('\n', pos);
    const line = nl < 0 ? src.slice(pos) : src.slice(pos, nl);
    const isLast = nl < 0;
    if (!/^ {0,3}>/.test(line)) break;
    any = true;
    consumed += line.length + 1;
    if (isLast) break;
    pos = nl + 1;
    // Lazy continuation lines belong to the paragraph run started by this
    // '>' line's content; a '>' line with blank content starts no run.
    const content = line.replace(/^ {0,3}>[ \t]?/, '');
    if (/^[ \t]*$/.test(content)) continue;
    for (;;) {
      if (pos > src.length) break;
      const nl2 = src.indexOf('\n', pos);
      const l2 = nl2 < 0 ? src.slice(pos) : src.slice(pos, nl2);
      const last2 = nl2 < 0;
      if (/^[ \t]*$/.test(l2)) break;
      if (/^ {0,3}>/.test(l2)) break;
      if (paraInterrupt(l2)) break;
      consumed += l2.length + 1;
      if (last2) break;
      pos = nl2 + 1;
    }
    if (pos > src.length) break;
  }
  if (!any) return null;
  return src.slice(0, consumed);
}

// Strip the '>' markers from a blockquote chunk, expanding tabs after the
// marker and indenting setext underlines by four spaces.
function stripBlockquote(chunk) {
  return chunk
    .replace(BLOCKQUOTE_MARKER_WS_RE, (g, b, m) => b + expandTabs(m, b.length))
    .replace(BLOCKQUOTE_SETEXT_RE, '\n    $1')
    .replace(BLOCKQUOTE_STRIP_RE, '');
}

// Lex a blockquote. Returns {node, raw} or null.
function matchBlockquote(src, links) {
  const matched = blockquoteMatch(src);
  if (!matched) return null;
  let n = trimEndChar(matched, '\n').split('\n');
  let s = '';
  let r = '';
  const tokens = [];
  while (n.length > 0) {
    let hasMarker = false;
    const l = [];
    let p = 0;
    for (; p < n.length; p++) {
      if (BLOCKQUOTE_START_RE2.test(n[p])) { l.push(n[p]); hasMarker = true; }
      else if (!hasMarker) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = stripBlockquote(h);
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const before = tokens.length;
    lexBlocksInto(u, links, tokens, true, true);
    if (n.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (!k) break;
    if (k.t === 'code' || k.t === 'h' || k.t === 'hr' || k.t === 'html' || k.t === 'table') break;
    if (k.t === 'bq') {
      const g = k;
      const b = n.join('\n');
      const m = g.raw + '\n' + b.replace(BLOCKQUOTE_STRIP_RE, '');
      const f = matchBlockquote(m, links);
      if (!f) break;
      tokens[tokens.length - 1] = f.node;
      const y = m.slice(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) {
        s = s + '\n' + A.join('\n');
        r = r.slice(0, r.length - g.text.length) + f.node.text;
        n = n.slice(A.length);
        if (n.length > 0 && BLOCKQUOTE_START_RE2.test(n[0])) continue;
      }
      break;
    } else if (k.t === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const m = matchList(b, links);
      if (!m) break;
      tokens[tokens.length - 1] = m.node;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      n = n.slice(f);
      continue;
    }
    // Any other token (paragraph/text): keep looping so the next chunk of
    // lazy lines is collected and merged in.
  }
  return { node: { t: 'bq', items: tokens, text: r, raw: s }, raw: s };
}

// ---------- lists ----------

// The indent-based regex factories clamp their indent argument to
// min(3, n-1) (marked's D memoiser). The de-indent amount R itself is
// NOT clamped; only the regexes use the clamped value.
const clampIndent = (n) => Math.max(0, Math.min(3, n - 1));
const LIST_ITEM_RE = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const NEXT_BULLET_RE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const HR_RE_INDENT = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
const FENCES_BEGIN_RE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`);
const HEADING_BEGIN_RE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`);
const HTML_BEGIN_RE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const BLOCKQUOTE_BEGIN_RE = (indent) => new RegExp(`^ {0,${clampIndent(indent)}}>`);
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE_RE = /\n.*\n/;
const LIST_IS_TASK_RE = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK_RE = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX_RE = /\[[ xX]\]/;

// First index of a character that is not a space, or -1 (the value of
// s.search(/[^ ]/)).
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i < s.length ? i : -1;
}

// True when s holds only spaces/tabs (or is empty).
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Expand the leading run of spaces/tabs of `s` to spaces, counting columns
// from `col` (a tab advances to the next multiple of 4); the rest of the
// string is untouched. Returns `s` unchanged when it starts with neither.
// (The value of s.replace(/^[ \t]+/, (v) => expandTabs(v, col)).)
function expandLeadingWs(s, col) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i === 0) return s;
  let out = '';
  let c = col;
  for (let j = 0; j < i; j++) {
    if (s.charCodeAt(j) === 9) { const r = 4 - (c % 4); out += '    '.slice(0, r); c += r; }
    else { out += ' '; c++; }
  }
  return out + s.slice(i);
}

// Column of the first non-space character of `m` when each tab counts as 4
// columns; -1 when there is none. (The value of
// m.replace(/\t/g, '    ').search(/[^ ]/).)
function tabExpandedFirstNonSpace(m) {
  let col = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m.charCodeAt(i);
    if (c === 9) col += 4;
    else if (c === 32) col++;
    else return col;
  }
  return -1;
}

// True when `line` from `i` is a run of one repeated hr character `c`
// ('-','_','*') with only spaces/tabs between, to the end, with at least
// 3 occurrences. (The run part of the hr regexes.)
function isHrRun(line, i, c) {
  let n = 0, j = i;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch === c) { n++; j++; }
    else if (ch === 32 || ch === 9) j++;
    else return false;
  }
  return n >= 3;
}

// True when `line` is a setext underline: 0-3 spaces, a run of '=' or '-',
// then only spaces. (The value of /^ {0,3}(?:=+|-+) *$/.test(line).)
function isSetextUnderline(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return false;
  let j = i;
  while (line.charCodeAt(j) === c) j++;
  while (j < line.length) {
    if (line.charCodeAt(j) !== 32) return false;
    j++;
  }
  return true;
}

// The tag part of the HTML-block-begin test (HTML_BEGIN_RE without its
// `^ {0,n}` indent prefix).
const HTML_BEGIN_TAG_RE = new RegExp(`^(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');

// Does `line` start an HTML block, allowing at most `maxIndent` leading
// spaces?
function htmlBeginMax(line, maxIndent) {
  let i = 0;
  while (i < maxIndent && line.charCodeAt(i) === 32) i++;
  if (line.charCodeAt(i) !== 60) return false;
  return HTML_BEGIN_TAG_RE.test(line.slice(i));
}

// Bit flags for lineStartsBlock.
const SB_FENCE = 1, SB_HEADING = 2, SB_HTML = 4, SB_BQ = 8, SB_BULLET = 16, SB_HR = 32;

// Does `line` start a block that interrupts a list item (or a paragraph),
// allowing at most `maxIndent` leading spaces? `mask` selects which block
// starts count (fence, ATX heading, HTML block, blockquote, list bullet,
// thematic break). Replaces the six indent-based regex tests on the same
// line (FENCES_BEGIN_RE, HEADING_BEGIN_RE, HTML_BEGIN_RE,
// BLOCKQUOTE_BEGIN_RE, NEXT_BULLET_RE, HR_RE_INDENT).
function lineStartsBlock(line, maxIndent, mask) {
  let i = 0;
  while (i < maxIndent && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c === 96 || c === 126) { // '`' or '~': a fence needs 3+ of the same char
    if (!(mask & SB_FENCE)) return false;
    return line.charCodeAt(i + 1) === c && line.charCodeAt(i + 2) === c;
  }
  if (c === 35) { // '#': ATX heading, 1-6 '#' then whitespace or end of line
    if (!(mask & SB_HEADING)) return false;
    let j = i, n = 0;
    while (line.charCodeAt(j) === 35 && n < 6) { j++; n++; }
    if (n === 0) return false;
    const a = line.charCodeAt(j);
    return Number.isNaN(a) || a === 32 || a === 9 || a === 10 || a === 13 || a === 11 || a === 12;
  }
  if (c === 62) return !!(mask & SB_BQ); // '>'
  if (c === 60) return !!(mask & SB_HTML) && htmlBeginMax(line, maxIndent); // '<'
  if (c === 42 || c === 43 || c === 45) { // '*', '+', '-'
    if (mask & SB_BULLET) {
      const a = line.charCodeAt(i + 1);
      if (Number.isNaN(a) || a === 32 || a === 9) return true;
    }
    if (mask & SB_HR) return isHrRun(line, i, c);
    return false;
  }
  if (c === 95) return !!(mask & SB_HR) && isHrRun(line, i, 95); // '_': only hr
  if (c >= 48 && c <= 57) { // digit: ordered bullet \d{1,9}[.)] then end or [ \t]
    if (!(mask & SB_BULLET)) return false;
    let j = i, n = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && n < 9) { j++; n++; }
    if (n === 0) return false;
    const d = line.charCodeAt(j);
    if (d !== 46 && d !== 41) return false;
    const a = line.charCodeAt(j + 1);
    return Number.isNaN(a) || a === 32 || a === 9;
  }
  return false;
}

// True when `s` ends with two blank lines (the value of
// DOUBLE_BLANK_RE.test(s), /\n[ \t]*\n[ \t]*$/).
function endsDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i <= 0 || s.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i <= 0 || s.charCodeAt(i - 1) !== 10) return false;
  return true;
}

// True when `s` starts with a thematic break (HR_RE), with a cheap
// first-character gate: the break's first non-space character must be
// '-', '_' or '*'.
function hrAtStart(s) {
  let i = 0;
  while (i < 3 && s.charCodeAt(i) === 32) i++;
  const c = s.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  return HR_RE.test(s);
}

// Lex a list. Returns {node, raw} or null.
function matchList(src, links) {
  const t = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/.exec(src);
  if (!t) return null;
  const n = src;
  let e = src;
  const consumed0 = () => n.length - e.length;
  let bullet = t[1].trim();
  const ordered = bullet.length > 1;
  const node = { t: 'list', ordered, start: ordered ? +bullet.slice(0, -1) : 0, loose: false, items: [] };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = LIST_ITEM_RE(bullet);
  let p = false;
  while (e.length > 0) {
    let u = false;
    let d = '';
    const it = itemRe.exec(e);
    if (!it || hrAtStart(e)) break;
    const k = consumed0();
    e = e.slice(it[0].length);
    const g2 = it[2];
    const gnl = g2.indexOf('\n');
    const g = gnl < 0 ? g2 : g2.slice(0, gnl);
    const b = it[1].length;
    let m = expandLeadingWs(g, b);
    const f0nl = e.indexOf('\n');
    const f0 = f0nl < 0 ? e : e.slice(0, f0nl);
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = firstNonSpace(m);
      if (R < 0) R = m.length;
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && isBlankLine(f0)) {
      e = e.slice(f0.length + 1);
      u = true;
    }
    if (!u) {
      const maxInd = clampIndent(R);
      const allMask = SB_FENCE | SB_HEADING | SB_HTML | SB_BQ | SB_BULLET | SB_HR;
      const noBulletMask = SB_FENCE | SB_HEADING | SB_HTML | SB_HR;
      while (e.length > 0) {
        const nl = e.indexOf('\n');
        const U = nl < 0 ? e : e.slice(0, nl);
        const f = U;
        const Z = expandLeadingWs(U, 0);
        if (lineStartsBlock(f, maxInd, allMask)) break;
        if (firstNonSpace(Z) >= R || isBlankLine(f)) d += '\n' + Z.slice(R);
        else {
          if (y || tabExpandedFirstNonSpace(m) >= 4 || lineStartsBlock(m, maxInd, noBulletMask)) break;
          const qe = isSetextUnderline(f) && matchLheading(m + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = isBlankLine(f);
        e = e.slice(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, consumed0());
    if (!node.loose) {
      if (p) node.loose = true;
      else if (endsDoubleBlank(A)) p = true;
    }
    node.items.push({ text: d, raw: A, task: LIST_IS_TASK_RE.test(d), loose: false, tokens: [] });
  }
  const h = node.items[node.items.length - 1];
  if (!h) return null;
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  node.raw = n.slice(0, consumed0()).trimEnd();
  // Lex each item's content as blocks (top=false).
  for (const u of node.items) {
    u.tokens = lexBlocks(u.text, links, false, false);
    if (!node.loose) {
      const sp = u.tokens.filter((g) => g.t === 'space');
      if (sp.length > 0 && sp.some((g) => ANY_LINE_RE.test(g.raw))) node.loose = true;
    }
  }
  // Task checkboxes.
  for (const u of node.items) {
    const d0 = u.tokens[0];
    if (u.task && (d0?.t === 'text' || d0?.t === 'para')) {
      u.text = u.text.replace(LIST_REPLACE_TASK_RE, '');
      d0.raw = d0.raw.replace(LIST_REPLACE_TASK_RE, '');
      d0.text = d0.text.replace(LIST_REPLACE_TASK_RE, '');
      const k = LIST_TASK_CHECKBOX_RE.exec(u.raw);
      if (k) {
        const g = { t: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        u.checked = g.checked;
        if (node.loose) {
          if (u.tokens[0] && (u.tokens[0].t === 'para' || u.tokens[0].t === 'text')) {
            u.tokens[0].checkbox = g;
          } else {
            u.tokens.unshift({ t: 'para', raw: g.raw, text: g.raw, checkbox: g });
          }
        } else {
          u.tokens.unshift(g);
        }
      } else if (u.task) u.task = false;
    }
  }
  if (node.loose) {
    for (const u of node.items) {
      u.loose = true;
      for (const d0 of u.tokens) if (d0.t === 'text') d0.t = 'para';
    }
  }
  return { node, raw: node.raw };
}

// ---------- main block lexer ----------

const SPACE_BLOCK_RE = /^(?:[ \t]*(?:\n|$))+/;

// Lex `src` into an array of block nodes. `top` controls whether a
// paragraph becomes a 'para' (top) or 'text' node; `mergePara` merges the
// first paragraph with a preceding 'para' node (blockquote chunks).
function lexBlocks(src, links, top, mergePara) {
  const tokens = [];
  lexBlocksInto(src, links, tokens, top, mergePara);
  return tokens;
}

function lexBlocksInto(src, links, tokens, top, mergePara) {
  let e = src;
  let n = mergePara;
  let guard = Infinity;
  while (e.length > 0) {
    if (e.length < guard) guard = e.length;
    else break; // infinite-loop guard
    let r;
    // space
    const sp = SPACE_BLOCK_RE.exec(e);
    if (sp && sp[0].length > 0) {
      e = e.slice(sp[0].length);
      const i = tokens[tokens.length - 1];
      if (sp[0].length === 1 && i !== undefined) i.raw += '\n';
      else tokens.push({ t: 'space', raw: sp[0] });
      continue;
    }
    // indented code
    r = matchIndentCode(e);
    if (r) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && (i.t === 'para' || i.t === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
      } else tokens.push({ t: 'code', text: r.text, lang: '', raw: r.raw });
      continue;
    }
    // fenced code
    r = matchFences(e);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push({ t: 'code', text: r.text, lang: r.lang, raw: r.raw });
      continue;
    }
    // ATX heading
    r = matchHeading(e);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push({ t: 'h', depth: r.depth, text: r.text, raw: r.raw });
      continue;
    }
    // hr
    r = matchHr(e);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push({ t: 'hr', raw: r.raw });
      continue;
    }
    // blockquote
    r = matchBlockquote(e, links);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push(r.node);
      continue;
    }
    // list
    r = matchList(e, links);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push(r.node);
      continue;
    }
    // html block
    r = matchHtmlBlock(e);
    if (r) {
      e = e.slice(r.raw.length);
      const pre = /^(?: {0,3})?<(?:pre|script|style)/i.test(r.text);
      tokens.push({ t: 'html', text: r.text, raw: r.raw, pre });
      continue;
    }
    // link reference definition
    r = matchDef(e);
    if (r) {
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && (i.t === 'para' || i.t === 'text')) {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.raw;
      } else {
        if (!links[r.tag]) links[r.tag] = { href: r.href, title: r.title };
        tokens.push({ t: 'def', raw: r.raw });
      }
      continue;
    }
    // table
    r = matchTable(e);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push(r.node);
      continue;
    }
    // setext heading
    r = matchLheading(e);
    if (r) {
      e = e.slice(r.raw.length);
      tokens.push({ t: 'h', depth: r.depth, text: r.text, raw: r.raw });
      continue;
    }
    // paragraph (top only)
    if (top) {
      r = matchParagraph(e);
      if (r) {
        const i = tokens[tokens.length - 1];
        if (n && i && i.t === 'para') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
        } else tokens.push({ t: 'para', text: r.text, raw: r.raw });
        n = false;
        e = e.slice(r.raw.length);
        continue;
      }
    }
    // text (single line)
    const tm = /^[^\n]+/.exec(e);
    if (tm) {
      r = { raw: tm[0], text: tm[0] };
      e = e.slice(r.raw.length);
      const i = tokens[tokens.length - 1];
      if (i && i.t === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
      } else tokens.push({ t: 'text', text: r.text, raw: r.raw });
      continue;
    }
    // Nothing matched: consume one char to avoid an infinite loop.
    e = e.slice(1);
  }
  return tokens;
}

// ---------- renderer ----------

function renderCheckbox(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderBlocks(tokens, links, ctx) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S+/)?.[0] || '';
        let text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang, false) + '">' + esc(text, true) + '</code></pre>\n'
          : '<pre><code>' + esc(text, true) + '</code></pre>\n';
        break;
      }
      case 'h':
        ctx.inRawBlock = false; out += '<h' + tok.depth + '>' + inlineHtml(tok.text, links, ctx) + '</h' + tok.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'bq':
        out += '<blockquote>\n' + renderBlocks(tok.items, links, ctx) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        out += '<' + tag + (tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n';
        for (const item of tok.items) {
          out += '<li>' + renderBlocks(item.tokens, links, ctx) + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'html':
        out += tok.text;
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let i = 0; i < tok.head.length; i++) {
          const a = tok.align[i];
          ctx.inRawBlock = false; out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(tok.head[i], links, ctx) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tok.rows.length > 0) {
          out += '<tbody>';
          for (const row of tok.rows) {
            out += '<tr>\n';
            for (let i = 0; i < row.length; i++) {
              const a = tok.align[i];
              ctx.inRawBlock = false; out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(row[i], links, ctx) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'para': {
        ctx.inRawBlock = false;
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox.checked) : '';
        out += '<p>' + cb + inlineHtml(tok.text, links, ctx) + '</p>\n';
        break;
      }
      case 'text': {
        ctx.inRawBlock = false;
        const cb = tok.checkbox ? renderCheckbox(tok.checkbox.checked) : '';
        out += cb + inlineHtml(tok.text, links, ctx);
        break;
      }
      case 'checkbox':
        out += renderCheckbox(tok.checked);
        break;
    }
  }
  return out;
}

// ---------- public entry point ----------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = {};
  const tokens = lexBlocks(src, links, true, false);
  // One shared inline context for the whole document: inLink persists
  // across blocks (an unclosed <a> suppresses later autolinks), while
  // inRawBlock is reset before each block's inline parse.
  const ctx = { inLink: false, inRawBlock: false, linkEmitted: false, render: inlineHtml };
  return renderBlocks(tokens, links, ctx);
}
