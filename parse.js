// parse.js — dependency-free Markdown renderer (CommonMark 0.31.2 + GFM),
// producing byte-identical HTML to marked 18.1.3 with default options
// (gfm on, breaks off, pedantic off, async off).

// ---------------- named entities ----------------
// Named references pass through untouched in marked's output, so this table
// is only consulted to decide whether an '&' starts a reference at all;
// the reference itself is emitted verbatim. Kept small on purpose.
const ENT = {
  AElig: 'Æ', AMP: '&', Aacute: 'Á', Acirc: 'Â', Agrave: 'À', Aring: 'Å',
  Atilde: 'Ã', Auml: 'Ä', Ccedil: 'Ç', ETH: 'Ð', Eacute: 'É', Ecirc: 'Ê',
  Egrave: 'È', Euml: 'Ë', Iacute: 'Í', Icirc: 'Î', Igrave: 'Ì', Iuml: 'Ï',
  Ntilde: 'Ñ', Oacute: 'Ó', Ocirc: 'Ô', Ograve: 'Ò', Oslash: 'Ø', Otilde: 'Õ',
  Ouml: 'Ö', THORN: 'Þ', Uacute: 'Ú', Ucirc: 'Û', Ugrave: 'Ù', Uuml: 'Ü',
  Yacute: 'Ý', aacute: 'á', acirc: 'â', acute: '´', aelig: 'æ', agrave: 'à',
  alefsym: 'ℵ', alpha: 'α', amp: '&', and: '∧', ang: '∠', apos: "'",
  aring: 'å', asymp: '≈', atilde: 'ã', auml: 'ä', bdquo: '„', beta: 'β',
  brvbar: '¦', bull: '•', cap: '∩', ccedil: 'ç', cedil: '¸', cent: '¢',
  chi: 'χ', circ: 'ˆ', clubs: '♣', cong: '≅', copy: '©', crarr: '↵',
  cup: '∪', curren: '¤', dArr: '⇓', dagger: '†', darr: '↓', deg: '°',
  delta: 'δ', diams: '♦', divide: '÷', eacute: 'é', ecirc: 'ê', egrave: 'è',
  empty: '∅', emsp: ' ', ensp: ' ', epsilon: 'ε', equiv: '≡', eta: 'η',
  eth: 'ð', euml: 'ë', euro: '€', exist: '∃', fnof: 'ƒ', forall: '∀',
  frac12: '½', frac14: '¼', frac34: '¾', frasl: '⁄', gamma: 'γ', ge: '≥',
  gt: '>', hArr: '⇔', harr: '↔', hearts: '♥', hellip: '…', iacute: 'í',
  icirc: 'î', iexcl: '¡', igrave: 'ì', image: 'ℑ', infin: '∞', int: '∫',
  iota: 'ι', iquest: '¿', isin: '∈', iuml: 'ï', kappa: 'κ', lArr: '⇐',
  lambda: 'λ', lang: '〈', laquo: '«', larr: '←', lceil: '⌈', ldquo: '“',
  le: '≤', lfloor: '⌊', lowast: '∗', loz: '◊', lrm: '‎', lsaquo: '‹',
  lsquo: '‘', lt: '<', macr: '¯', mdash: '—', micro: 'µ', middot: '·',
  minus: '−', mu: 'μ', nabla: '∇', nbsp: ' ', ndash: '–', ne: '≠',
  ni: '∋', not: '¬', notin: '∉', nsub: '⊄', ntilde: 'ñ', nu: 'ν',
  oacute: 'ó', ocirc: 'ô', ograve: 'ò', oline: '‾', omega: 'ω',
  omicron: 'ο', oplus: '⊕', or: '∨', ordf: 'ª', ordm: 'º', oslash: 'ø',
  otilde: 'õ', otimes: '⊗', ouml: 'ö', para: '¶', part: '∂', perp: '⊥',
  phi: 'φ', pi: 'π', piv: 'ϖ', plusmn: '±', pound: '£', prime: '′',
  prod: '∏', prop: '∝', psi: 'ψ', quot: '"', rArr: '⇒', radic: '√',
  rang: '〉', raquo: '»', rarr: '→', rceil: '⌉', rdquo: '”', real: 'ℜ',
  reg: '®', rfloor: '⌋', rho: 'ρ', rlm: '‏', rsaquo: '›', rsquo: '’',
  sbquo: '‚', scaron: 'š', Scaron: 'Š', sdot: '⋅', sect: '§', shy: '­',
  sigma: 'σ', sigmaf: 'ς', sim: '∼', spades: '♠', sub: '⊂', sube: '⊆',
  sum: '∑', sup: '⊃', sup1: '¹', sup2: '²', sup3: '³', supe: '⊇',
  szlig: 'ß', tau: 'τ', there4: '∴', theta: 'θ', thetasym: 'ϑ', thinsp: ' ',
  thorn: 'þ', tilde: '˜', times: '×', trade: '™', uArr: '⇑', uacute: 'ú',
  uarr: '↑', ucirc: 'û', ugrave: 'ù', uml: '¨', upsih: 'ϒ', upsilon: 'υ',
  uuml: 'ü', weierp: '℘', xi: 'ξ', yacute: 'ý', yen: '¥', yuml: 'ÿ',
  Yuml: 'Ÿ', zeta: 'ζ', zwj: '‍', zwnj: '‌', oelig: 'œ', OElig: 'Œ',
  Dagger: '‡', permil: '‰', Prime: '″', euro2: '€',
};

// ---------------- small helpers ----------------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// '&' is left alone when it starts a character reference (&name; or &#123;).
const ESC_RE = /[<>"']|&(?!(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;
const ESC_CODE_RE = /[&<>"']/g;
// Strict escape for code content: every '&' is literal (no entity pass-through).
function escCode(s) {
  return s.replace(ESC_CODE_RE, (c) => ESC_MAP[c]);
}
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c] || '&amp;');
}
const NUM_REF_RE = /&#(\d+);|&#[xX]([0-9a-fA-F]+);/g;
function decodeNumeric(s) {
  if (!s.includes('&#')) return s;
  return s.replace(NUM_REF_RE, (_m, dec, hex) => {
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    // Out of range (> U+10FFFF) is not a character reference at all: the
    // '&' stays literal (esc() turns it into &amp;).
    if (n > 0x10FFFF) return '&amp;' + _m.slice(1);
    if (!n || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    return String.fromCodePoint(n);
  });
}
const BS_ESC_RE = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g;
function unescapeBackslash(s) {
  return s.includes('\\') ? s.replace(BS_ESC_RE, '$1') : s;
}
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
}
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ';
}
const ASCII_PUNCT_RE = /[!-\/:-@\[-`{-~]/;
function isPunct(ch) {
  if (!ch) return false;
  if (ch.length !== 1) return false;
  // CommonMark "punctuation" = Unicode P (punctuation) or S (symbol).
  return ASCII_PUNCT_RE.test(ch) || /[\p{P}\p{S}]/u.test(ch);
}
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT_RE.test(ch);
}
function isBlank(line) {
  return /^[ \t]*$/.test(line);
}
// Width of the leading whitespace of a line, in columns (tab = to next multiple of 4).
function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') n++;
    else if (c === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}
// Remove n columns of leading indentation from a line (raw strip: a tab
// that straddles the boundary leaves spaces; the rest is kept as-is).
// Used for indented code content, where tabs must be preserved.
function stripIndent(line, n) {
  let col = 0, i = 0, out = '';
  while (i < line.length && col < n) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else { out += ' '.repeat(col + w - n); col = n; i++; }
    } else break;
  }
  return out + line.slice(i);
}
// Remove n columns of leading indentation, expanding the leading whitespace
// run to spaces (column-aware) first so the result is column-correct for
// re-parsing (used for list item / blockquote content lines).
function stripIndentExpand(line, n) {
  let col = 0, i = 0, expanded = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { expanded += ' '; col++; i++; }
    else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; i++; }
  }
  const rest = line.slice(i);
  if (expanded.length <= n) return rest;
  return expanded.slice(n) + rest;
}
// Remove up to n columns of leading indentation from fenced code content.
// A tab that starts within the strip range is removed entirely.
function stripFenceIndent(line, n) {
  let col = 0, i = 0;
  while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { col++; i++; }
    else { const w = 4 - (col % 4); col += w; i++; }
  }
  return line.slice(i);
}
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}
// Parse a list item marker line, column-aware (a tab advances to the next
// multiple of 4). Returns null if the line is not a marker line.
// {base, marker, ordered, delim, spaces, content, contentIndent}
function parseMarker(line) {
  let i = 0, base = 0;
  while (i < line.length && line[i] === ' ' && base < 4) { base++; i++; }
  if (base >= 4) return null;
  let marker = '';
  if (line[i] === '-' || line[i] === '+' || line[i] === '*') {
    marker = line[i];
    i++;
  } else {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - i < 9) j++;
    if (j === i || j - i > 9) return null;
    if (line[j] !== '.' && line[j] !== ')') return null;
    marker = line.slice(i, j + 1);
    i = j + 1;
  }
  const ordered = /^\d/.test(marker);
  let col = base + marker.length;
  let spaces = 0;
  let k = i;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { spaces++; col++; k++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; k++; }
  }
  let content, contentIndent;
  if (k >= line.length) {
    content = '';
    contentIndent = base + marker.length + 1;
  } else if (spaces >= 5) {
    contentIndent = base + marker.length + 1;
    content = ' '.repeat(spaces - 1) + line.slice(k);
  } else if (spaces === 0) {
    return null;
  } else {
    contentIndent = base + marker.length + spaces;
    content = line.slice(k);
  }
  return { base, marker, ordered, delim: ordered ? marker.slice(-1) : marker, spaces, content, contentIndent };
}
// Strip a blockquote marker (up to 3 spaces, '>', then at most one column
// of following whitespace) from a line. The remaining leading whitespace is
// expanded to spaces (column-aware) so the result is column-correct for
// re-parsing. Returns the content or null.
function stripBqMarker(line) {
  let i = 0, col = 0;
  while (i < line.length && line[i] === ' ' && col < 3) { col++; i++; }
  if (line[i] !== '>') return null;
  i++; col++;
  let out = '';
  if (i < line.length && line[i] === ' ') { i++; col++; }
  else if (i < line.length && line[i] === '\t') {
    const w = 4 - (col % 4);
    out += ' '.repeat(w - 1);
    col += w;
    i++;
  }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(i);
}

// Strip all leading blockquote markers, returning the innermost content.
function innermostBq(line) {
  let cur = line;
  for (;;) {
    const s = stripBqMarker(cur);
    if (s === null) return cur;
    cur = s;
  }
}

// ---------------- inline parsing ----------------
function inlineText(s, refs) {
  return renderNodes(inlineNodes(s, refs).nodes);
}

function inlineNodes(s, refs) {
  const nodes = [];
  let hasLink = false;
  const n = s.length;
  let i = 0;
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'text', s: text }); text = ''; } };
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) {
      const d = s[i + 1];
      if (d === '\n') { flush(); nodes.push({ t: 'br' }); i += 2; continue; }
      // A backslash-escaped '&' is a literal ampersand, not the start of a
      // character reference: keep it in its own text node so esc() turns it
      // into &amp; instead of passing '&name;' through as an entity.
      if (d === '&') { flush(); nodes.push({ t: 'text', s: '&' }); i += 2; continue; }
      if (isAsciiPunct(d)) { text += d; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === '`') {
      let j = i, cnt = 0;
      while (j < n && s[j] === '`') { cnt++; j++; }
      let k = j, end = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k, c2 = 0;
          while (m < n && s[m] === '`') { c2++; m++; }
          if (c2 === cnt) { end = k; break; }
          k = m;
        } else k++;
      }
      if (end === -1) { text += s.slice(i, j); i = j; continue; }
      let content = s.slice(j, end);
      if (content.includes('\n')) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(); nodes.push({ t: 'code', s: content }); i = end + cnt; continue;
    }
    if (c === '<') {
      const a = tryAutolink(s, i);
      if (a) { flush(); nodes.push(a.node); if (a.node.t === 'link') hasLink = true; i = a.end; continue; }
      const h = tryHtmlTag(s, i);
      if (h) { flush(); nodes.push({ t: 'html', s: h }); i += h.length; continue; }
      text += c; i++; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const r = tryLink(s, i, refs, true);
      if (r) {
        const inner = inlineNodes(r.labelText, refs);
        flush(); nodes.push({ t: 'img', src: r.href, title: r.title, alt: inner.nodes }); i = r.end; continue;
      }
      text += c; i++; continue;
    }
    if (c === '[') {
      const r = tryLink(s, i, refs, false);
      if (r) {
        const inner = inlineNodes(r.labelText, refs);
        if (!inner.hasLink) {
          flush(); nodes.push({ t: 'link', href: r.href, title: r.title, inner: inner.nodes });
          hasLink = true; i = r.end; continue;
        }
      }
      text += c; i++; continue;
    }
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      const before = i > 0 ? s[i - 1] : '';
      const after = j < n ? s[j] : '';
      // The beginning and end of the line count as whitespace for flanking.
      const beforeWs = i === 0 || isWs(before);
      const afterWs = j === n || isWs(after);
      const leftFlank = !afterWs && (!isPunct(after) || beforeWs || isPunct(before));
      const rightFlank = !beforeWs && (!isPunct(before) || afterWs || isPunct(after));
      let open, close;
      if (c === '*') { open = leftFlank; close = rightFlank; }
      else { open = leftFlank && (!rightFlank || isPunct(before)); close = rightFlank && (!leftFlank || isPunct(after)); }
      flush(); nodes.push({ t: 'delim', ch: c, n: len, open, close }); i = j; continue;
    }
    if (c === '~' && s[i + 1] === '~') {
      const after = i + 2 < n ? s[i + 2] : '';
      if (after && !isWs(after)) {
        let k = i + 2, found = -1;
        while (k < n - 1) {
          if (s[k] === '~' && s[k + 1] === '~' && !isWs(s[k - 1])) { found = k; break; }
          k++;
        }
        if (found !== -1) {
          const inner = inlineNodes(s.slice(i + 2, found), refs);
          flush(); nodes.push({ t: 'del', inner: inner.nodes }); i = found + 2; continue;
        }
      }
      text += '~~'; i += 2; continue;
    }
    if (c === '&') {
      const m = /^&#\d+;|^&#[xX][0-9a-fA-F]+;/.exec(s.slice(i));
      if (m) { text += decodeNumeric(m[0]); i += m[0].length; continue; }
      text += c; i++; continue;
    }
    if (c === '\n') {
      if (/  $/.test(text)) { text = text.replace(/ +$/, ''); flush(); nodes.push({ t: 'br' }); i++; continue; }
      text += c; i++; continue;
    }
    if (c === 'w' || c === 'h' || c === 'f' || c === 'a' || (c >= 'b' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '!' || c === '#' || c === '$' || c === '%' || c === "'" || c === '+' || c === '/' || c === '=' || c === '?' || c === '^' || c === '`' || c === '{' || c === '|' || c === '}' || c === '-' || c === '_') {
      const prev = i > 0 ? s[i - 1] : '';
      if (i === 0 || isWs(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
        const a = tryExtAutolink(s, i);
        if (a) {
          flush();
          nodes.push({ t: 'link', href: a.href, title: null, inner: [{ t: 'text', s: a.text }] });
          hasLink = true; i = a.end; continue;
        }
      }
      text += c; i++; continue;
    }
    text += c; i++;
  }
  flush();
  processDelims(nodes);
  return { nodes, hasLink };
}

function collectDelims(nodes) {
  const out = [];
  for (let idx = 0; idx < nodes.length; idx++) if (nodes[idx].t === 'delim') out.push(idx);
  return out;
}

function processDelims(nodes) {
  let delims = collectDelims(nodes);
  let di = 0;
  while (di < delims.length) {
    const ci = delims[di];
    const closer = nodes[ci];
    if (!closer || closer.t !== 'delim' || closer.n === 0 || !closer.close) { di++; continue; }
    let oi = -1;
    for (let e = di - 1; e >= 0; e--) {
      const op = nodes[delims[e]];
      if (!op || op.t !== 'delim' || op.n === 0 || op.ch !== closer.ch || !op.open) continue;
      if (op.open && op.close && closer.open && closer.close && (op.n + closer.n) % 3 === 0 && op.n % 3 !== 0) continue;
      oi = delims[e]; break;
    }
    if (oi === -1) { di++; continue; }
    const opener = nodes[oi];
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const inner = nodes.slice(oi + 1, ci);
    const wrap = { t: use === 2 ? 'strong' : 'em', inner };
    opener.n -= use;
    closer.n -= use;
    const out = [];
    for (let k = 0; k < oi; k++) out.push(nodes[k]);
    if (opener.n > 0) out.push(opener);
    out.push(wrap);
    if (closer.n > 0) out.push(closer);
    for (let k = ci + 1; k < nodes.length; k++) out.push(nodes[k]);
    nodes.length = 0;
    for (const nd of out) nodes.push(nd);
    delims = collectDelims(nodes);
    const wi = nodes.indexOf(wrap);
    di = delims.findIndex((idx) => idx > wi);
    if (di === -1) di = delims.length;
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'code': out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += esc(nd.ch.repeat(nd.n)); break;
      case 'link': {
        const h = cleanUrl(nd.href);
        if (h === null) { out += renderNodes(nd.inner); break; }
        out += '<a href="' + esc(h) + '"' + (nd.title != null ? ' title="' + esc(nd.title) + '"' : '') + '>' + renderNodes(nd.inner) + '</a>';
        break;
      }
      case 'img': {
        const h = cleanUrl(nd.src);
        if (h === null) { out += esc(stripTags(renderNodes(nd.alt))); break; }
        out += '<img src="' + esc(h) + '" alt="' + esc(stripTags(renderNodes(nd.alt))) + '"' + (nd.title != null ? ' title="' + esc(nd.title) + '"' : '') + '>';
        break;
      }
      case 'em': out += '<em>' + renderNodes(nd.inner) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.inner) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.inner) + '</del>'; break;
    }
  }
  return out;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

// <scheme:...> or <email> autolinks.
function tryAutolink(s, i) {
  const rest = s.slice(i);
  let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
  if (m) {
    const url = m[1];
    return { node: { t: 'link', href: url, title: null, inner: [{ t: 'text', s: url }] }, end: i + m[0].length };
  }
  m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
  if (m) {
    const em = m[1];
    return { node: { t: 'link', href: 'mailto:' + em, title: null, inner: [{ t: 'text', s: em }] }, end: i + em.length };
  }
  return null;
}

const HTML_TAG_RE = /^<!--[\s\S]*?-->|^<\/?[a-zA-Z][A-Za-z0-9-]*(?=[ \t/>])[^<>]*>|^<\?[\s\S]*?\?>|^<![a-zA-Z][^<>]*>|^<!\[CDATA\[[\s\S]*?\]\]>/;
function tryHtmlTag(s, i) {
  const m = HTML_TAG_RE.exec(s.slice(i));
  return m ? m[0] : null;
}

// Find the end of a code span's closing backtick run; -1 if none.
function findCodeEnd(s, from, cnt) {
  let k = from;
  while (k < s.length) {
    if (s[k] === '`') {
      let m = k, c2 = 0;
      while (m < s.length && s[m] === '`') { c2++; m++; }
      if (c2 === cnt) return k;
      k = m;
    } else k++;
  }
  return -1;
}

// Parse the "(...)" part of an inline link starting at s[k] === '('.
// Returns {href, title, end} or null. Destinations and titles are decoded.
function parseLinkParens(s, k) {
  const n = s.length;
  let p = k + 1;
  const skipWs = () => {
    let seenNl = false;
    while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) {
      if (s[p] === '\n') {
        if (seenNl) return false;
        seenNl = true;
      }
      p++;
    }
    return true;
  };
  if (!skipWs()) return null;
  if (p >= n) return null;
  let href;
  if (s[p] === '<') {
    let q = p + 1;
    while (q < n && s[q] !== '>' && s[q] !== '\n') {
      if (s[q] === '\\' && q + 1 < n) q += 2;
      else q++;
    }
    if (q >= n || s[q] !== '>') return null;
    href = decodeNumeric(unescapeBackslash(s.slice(p + 1, q)));
    p = q + 1;
  } else {
    let q = p, depth = 0;
    while (q < n) {
      const c = s[q];
      if (c === '\\' && q + 1 < n) { q += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (q === p) href = '';
    else href = decodeNumeric(unescapeBackslash(s.slice(p, q)));
    p = q;
  }
  if (!skipWs()) return null;
  if (p >= n) return null;
  let title = null;
  if (s[p] === ')') return { href, title, end: p + 1 };
  const tc = s[p];
  if (tc === '"' || tc === "'" || tc === '(') {
    const closer = tc === '(' ? ')' : tc;
    let q = p + 1;
    while (q < n && s[q] !== closer) {
      if (s[q] === '\\' && q + 1 < n && (s[q + 1] === closer || s[q + 1] === '\\')) { q += 2; continue; }
      if (s[q] === '\n' && s[q + 1] === '\n') return null;
      q++;
    }
    if (q >= n) return null;
    title = decodeNumeric(unescapeBackslash(s.slice(p + 1, q)));
    p = q + 1;
    if (!skipWs()) return null;
    if (p >= n || s[p] !== ')') return null;
    return { href, title, end: p + 1 };
  }
  return null;
}

// Try to parse a link or image starting at s[i] ('[' or '![').
// Returns {labelText, href, title, end} or null.
function tryLink(s, i, refs, isImage) {
  const start = isImage ? i + 1 : i;
  const n = s.length;
  let depth = 0, j = start + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      let k = j, cnt = 0;
      while (k < n && s[k] === '`') { cnt++; k++; }
      const close = findCodeEnd(s, k, cnt);
      if (close === -1) { j = k; continue; }
      j = close + cnt; continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j >= n || s[j] !== ']') return null;
  const labelText = s.slice(start + 1, j);
  let k = j + 1;
  let href = null, title = null;
  if (s[k] === '(') {
    const res = parseLinkParens(s, k);
    if (!res) return null;
    href = res.href; title = res.title; k = res.end;
  } else if (s[k] === '[') {
    const m = s.indexOf(']', k + 1);
    if (m === -1) return null;
    const lab = s.slice(k + 1, m);
    const ref = refs[normalizeLabel(lab === '' ? labelText : lab)];
    if (!ref) return null;
    href = ref.href; title = ref.title; k = m + 1;
  } else {
    const ref = refs[normalizeLabel(labelText)];
    if (!ref) return null;
    href = ref.href; title = ref.title; k = j + 1;
  }
  return { labelText, href, title, end: k };
}

// Extended (GFM) autolinks: www., http(s)://, ftp://, and bare emails.
function trimExtEnd(link) {
  let end = link.length;
  for (;;) {
    if (end === 0) break;
    const c = link[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === '*' || c === '_' || c === '~') { end--; continue; }
    if (c === ';' || c === '&') {
      const amp = link.lastIndexOf('&', end - 1);
      if (amp !== -1 && /^&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);$/.test(link.slice(amp, end))) break;
      end--; continue;
    }
    if (c === ')') {
      let open = 0, close = 0;
      for (let x = 0; x < end; x++) {
        if (link[x] === '(') open++;
        else if (link[x] === ')') close++;
      }
      if (close > open) { end--; continue; }
    }
    break;
  }
  return link.slice(0, end);
}
function scanExtRun(s, i) {
  let j = i;
  while (j < s.length && !isWs(s[j]) && s[j] !== '<') j++;
  return trimExtEnd(s.slice(i, j));
}
function validDomainLabels(dom) {
  const parts = dom.split('.');
  if (parts.length < 2) return false;
  for (const p of parts) {
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(p)) return false;
  }
  return true;
}
function tryExtAutolink(s, i) {
  if (s.startsWith('www.', i)) {
    const raw = scanExtRun(s, i);
    if (raw.length <= 4) return null;
    const rest = raw.slice(4);
    const slash = rest.indexOf('/');
    const dom = slash === -1 ? rest : rest.slice(0, slash);
    if (!validDomainLabels(dom)) return null;
    return { href: 'http://' + raw, text: raw, end: i + raw.length };
  }
  for (const scheme of ['https://', 'http://', 'ftp://']) {
    if (s.startsWith(scheme, i)) {
      const raw = scanExtRun(s, i);
      const rest = raw.slice(scheme.length);
      const slash = rest.indexOf('/');
      const dom = slash === -1 ? rest : rest.slice(0, slash);
      const domNoPort = dom.split(':')[0];
      if (!validDomainLabels(domNoPort)) return null;
      return { href: raw, text: raw, end: i + raw.length };
    }
  }
  const m = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/.exec(s.slice(i));
  if (m) {
    const em = m[0];
    return { href: 'mailto:' + em, text: em, end: i + em.length };
  }
  return null;
}

// ---------------- block parsing ----------------
// Tokenize lines into block tokens; refs are collected along the way.
function tokenize(lines, refs, lazy) {
  const tokens = [];
  const N = lines.length;
  let i = 0;
  while (i < N) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const def = tryDef(lines, i, refs);
    if (def) { i = def.next; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (atx) {
      let content = atx[2] === undefined ? '' : atx[2];
      content = content.replace(/^#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
      tokens.push({ t: 'heading', level: atx[1].length, text: content });
      i++;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const ch = fence[1][0];
      const flen = fence[1].length;
      const findent = indentOf(line);
      const info = fence[2].trim();
      const content = [];
      i++;
      while (i < N) {
        const l = lines[i];
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (cm && cm[1][0] === ch && cm[1].length >= flen) { i++; break; }
        content.push(stripFenceIndent(l, findent));
        i++;
      }
      // Only a single completely-empty trailing line is dropped.
      if (content.length && content[content.length - 1] === '') content.pop();
      tokens.push({ t: 'code', lang: info ? unescapeBackslash(info.split(/\s+/)[0]) : '', text: content.length ? content.join('\n') + '\n' : '' });
      continue;
    }
    const html = tryHtmlBlock(lines, i);
    if (html) {
      tokens.push({ t: 'html', lines: html.lines, keepNl: html.keepNl });
      i = html.next;
      continue;
    }
    const hr = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.exec(line);
    if (hr) { tokens.push({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const bq = [];
      const bqLazy = new Set();
      let inFence = false;
      while (i < N) {
        const l = lines[i];
        const stripped = stripBqMarker(l);
        if (stripped !== null) {
          bq.push(stripped);
          if (/^ {0,3}(`{3,}|~{3,})/.test(stripped)) inFence = !inFence;
          i++;
          continue;
        }
        // A blank line without a '>' ends the blockquote.
        if (isBlank(l)) break;
        // Lazy continuation: only when the content currently ends with a
        // paragraph line, the line is not a block start, and we are not
        // inside a fenced code block.
        if (!inFence && bq.length && bq[bq.length - 1] !== '' && isParaLine(innermostBq(bq[bq.length - 1])) && !startsBlock(l)) {
          if (/^ {0,3}=+[ \t]*$/.test(l)) {
            // A setext underline cannot be a lazy continuation: indent it.
            bqLazy.add(bq.length);
            bq.push('    ' + l.replace(/^[ \t]+/, ''));
            i++;
            continue;
          }
          bqLazy.add(bq.length);
          bq.push(indentOf(l) >= 4 ? stripIndent(l, 4) : l);
          i++;
          continue;
        }
        break;
      }
      while (bq.length && isBlank(bq[bq.length - 1])) bq.pop();
      tokens.push({ t: 'blockquote', tokens: tokenize(bq, refs, bqLazy) });
      continue;
    }
    const list = tryList(lines, i, refs);
    if (list) {
      tokens.push(list.token);
      i = list.next;
      continue;
    }
    if (indentOf(line) >= 4) {
      const content = [];
      while (i < N) {
        const l = lines[i];
        if (isBlank(l)) { content.push(stripIndent(l, 4)); i++; continue; }
        if (indentOf(l) >= 4) { content.push(stripIndent(l, 4)); i++; continue; }
        break;
      }
      while (content.length && isBlank(content[content.length - 1])) content.pop();
      tokens.push({ t: 'code', lang: '', text: content.length ? content.join('\n') + '\n' : '' });
      continue;
    }
    // Paragraph (with setext heading and table checks).
    const paraLines = [line];
    i++;
    let setext = 0;
    let table = null;
    while (i < N) {
      const l = lines[i];
      if (isBlank(l)) break;
      // A lazy continuation line is paragraph text; it cannot start a
      // new block (setext, table, heading, list, ...).
      if (lazy && lazy.has(i)) { paraLines.push(l); i++; continue; }
      const se = /^ {0,3}(=+|-+)[ \t]*$/.exec(l);
      if (se) { setext = se[1][0] === '=' ? 1 : 2; i++; break; }
      if (paraLines.length === 1) {
        const d = parseTableDelim(l);
        if (d && splitCells(paraLines[0]).length === d.length) {
          table = { align: d, header: splitCells(paraLines[0]), rows: [] };
          i++;
          while (i < N && !isBlank(lines[i])) {
            table.rows.push(splitCells(lines[i]));
            i++;
          }
          break;
        }
      }
      if (startsBlock(l)) break;
      paraLines.push(l);
      i++;
    }
    if (table) { tokens.push({ t: 'table', align: table.align, header: table.header, rows: table.rows }); continue; }
    if (setext) { tokens.push({ t: 'heading', level: setext, text: paraLines.join('\n').replace(/^ {0,3}/, '') }); continue; }
    tokens.push({ t: 'para', text: paraLines.join('\n') });
  }
  return tokens;
}

// Could line l be part of a paragraph (not blank, not a block start, not indented code)?
function isParaLine(l) {
  if (isBlank(l)) return false;
  if (indentOf(l) >= 4) return false;
  if (startsBlock(l)) return false;
  return true;
}

// Does line l start a block that can interrupt a paragraph?
function startsBlock(l) {
  if (/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(l)) return true;
  if (/^ {0,3}(`{3,}|~{3,})/.test(l)) return true;
  if (isHtmlBlockStart(l, true)) return true;
  if (/^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(l)) return true;
  if (/^ {0,3}>/.test(l)) return true;
  const lm = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+(\S.*))?$/.exec(l);
  if (lm) {
    if (/^\d/.test(lm[1])) {
      const num = parseInt(lm[1], 10);
      if (num === 1 && lm[3] !== undefined) return true;
    } else if (lm[3] !== undefined) return true;
  }
  return false;
}

const HTML_BLOCK_STARTS = [
  { re: /^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i, end: /<\/(script|pre|style|textarea)>/i, type: 1 },
  { re: /^ {0,3}<!--/, end: /-->/, type: 2 },
  { re: /^ {0,3}<\?/, end: /\?>/, type: 3 },
  { re: /^ {0,3}<![A-Za-z]/, end: />/, type: 4 },
  { re: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, type: 5 },
  { re: /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s>\/]|$)/i, end: null, type: 6 },
  { re: /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?=[ \t/>])[^<>]*>[ \t]*$/, end: null, type: 7 },
];
function htmlBlockStart(line, inPara) {
  for (const h of HTML_BLOCK_STARTS) {
    if (h.type === 7 && inPara) continue;
    if (h.re.test(line)) return h;
  }
  return null;
}
function isHtmlBlockStart(line, inPara) {
  return htmlBlockStart(line, inPara) !== null;
}
// Keep the trailing newline after an HTML block unless the next line is a
// real blank line (a final empty element is the phantom from splitting a
// source that ends in "\n", not a blank line).
function htmlKeepNl(lines, e) {
  const N = lines.length;
  if (e >= N) return false;
  if (e < N - 1 && isBlank(lines[e])) return false;
  return true;
}
function tryHtmlBlock(lines, i) {
  const h = htmlBlockStart(lines[i], false);
  if (!h) return null;
  const out = [lines[i]];
  i++;
  if (h.type <= 5) {
    if (h.end.test(out[0])) return { lines: out, next: i, keepNl: htmlKeepNl(lines, i) };
    while (i < lines.length) {
      if (i === lines.length - 1 && lines[i] === '') break;
      out.push(lines[i]);
      i++;
      if (h.end.test(out[out.length - 1])) break;
    }
    return { lines: out, next: i, keepNl: htmlKeepNl(lines, i) };
  }
  while (i < lines.length && !isBlank(lines[i])) {
    out.push(lines[i]);
    i++;
  }
  return { lines: out, next: i, keepNl: htmlKeepNl(lines, i) };
}

// Try to parse a link reference definition starting at lines[i].
// Returns {next} or null. The definition is recorded in refs (first wins).
function tryDef(lines, i, refs) {
  const line = lines[i];
  const m = /^ {0,3}\[([^\]]{1,999})\]:[ \t]*(.*)$/.exec(line);
  if (!m) return null;
  const label = m[1];
  if (/[\x00-\x1f]/.test(label)) return null;
  let j = i;
  let rest = m[2];
  const nextLine = () => {
    if (j + 1 < lines.length && !isBlank(lines[j + 1]) && indentOf(lines[j + 1]) <= 3) { j++; return lines[j].replace(/^ {0,3}/, ''); }
    return null;
  };
  let dest = null, title = null;
  if (rest.trim() === '') {
    const nl = nextLine();
    if (nl === null) return null;
    rest = nl;
  }
  rest = rest.replace(/^[ \t]+/, '');
  if (rest.startsWith('<')) {
    let q = 1;
    while (q < rest.length && rest[q] !== '>') {
      if (rest[q] === '\\' && q + 1 < rest.length) q += 2;
      else q++;
    }
    if (q >= rest.length) return null;
    dest = decodeNumeric(unescapeBackslash(rest.slice(1, q)));
    rest = rest.slice(q + 1);
  } else {
    const dm = /^[^\s\x00-\x1f]+/.exec(rest);
    if (!dm) return null;
    dest = decodeNumeric(unescapeBackslash(dm[0]));
    rest = rest.slice(dm[0].length);
  }
  rest = rest.replace(/^[ \t]+/, '');
  if (rest === '') {
    const nl = nextLine();
    if (nl !== null) rest = nl.replace(/^[ \t]+/, '');
  }
  if (rest !== '') {
    const tc = rest[0];
    if (tc === '"' || tc === "'" || tc === '(') {
      const closer = tc === '(' ? ')' : tc;
      let q = 1;
      while (q < rest.length && rest[q] !== closer) {
        if (rest[q] === '\\' && q + 1 < rest.length && (rest[q + 1] === closer || rest[q + 1] === '\\')) q += 2;
        else q++;
      }
      if (q >= rest.length) return null;
      title = decodeNumeric(unescapeBackslash(rest.slice(1, q)));
      rest = rest.slice(q + 1);
      if (rest.trim() !== '') return null;
    } else return null;
  }
  const key = normalizeLabel(label);
  if (!(key in refs)) refs[key] = { href: dest, title };
  return { next: j + 1 };
}

// Split a table line into cells (unescaped pipes), trimming outer empties.
function splitCells(line) {
  const cells = [];
  let cur = '';
  for (let x = 0; x < line.length; x++) {
    const c = line[x];
    if (c === '\\' && x + 1 < line.length && line[x + 1] === '|') { cur += '|'; x++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}
// Parse a table delimiter row; returns align array ('left'|'right'|'center'|null) or null.
function parseTableDelim(line) {
  if (indentOf(line) >= 4) return null;
  const cells = splitCells(line);
  if (!cells.length) return null;
  const align = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    align.push(m[1] === ':' && m[2] === ':' ? 'center' : m[1] === ':' ? 'left' : m[2] === ':' ? 'right' : null);
  }
  return align;
}

// Try to parse a list starting at lines[i]. Returns {token, next} or null.
function tryList(lines, i, refs) {
  const first = parseMarker(lines[i]);
  if (!first) return null;
  const ordered = first.ordered;
  const delim = first.delim;
  const bullet = ordered ? null : first.marker;
  const startNum = ordered ? parseInt(first.marker, 10) : null;
  const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  const items = [];
  let loose = false;
  let j = i;
  let cur = first;
  while (j < lines.length) {
    const line = lines[j];
    // A thematic break ends the list (it is not a list item).
    if (HR_RE.test(line)) break;
    const m = cur === first && j === i ? first : parseMarker(line);
    if (!m) break;
    if (ordered) {
      if (!m.ordered || m.delim !== delim) break;
    } else if (!m.ordered && m.marker !== bullet) break;
    else if (m.ordered) break;
    const contentIndent = m.contentIndent;
    const itemLines = [m.content];
    const itemLazy = new Set();
    let itemBlankInside = false;
    let sawBlank = false;
    let blankSeen = false;
    j++;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        if (itemLines.some((x) => x !== '')) sawBlank = true;
        blankSeen = true;
        itemLines.push('');
        j++;
        continue;
      }
      // An empty item followed by a blank line is complete; following
      // lines belong outside the list.
      if (blankSeen && !itemLines.some((x) => x !== '')) break;
      const nm = parseMarker(l);
      // A marker line shallower than this item's content indent ends the
      // item (sibling item or a different list); deeper markers are nested
      // content and fall through to the indent branch below.
      if (nm && nm.base < contentIndent) break;
      if (indentOf(l) >= contentIndent) {
        let s = stripIndentExpand(l, contentIndent);
        // A continuation line that directly follows non-blank content and
        // still has >= 4 columns of indent loses 4 more columns (indented
        // code content) but stays a paragraph continuation; after a blank
        // line it is left for the block parser (indented code block).
        const prevBlank = itemLines.length && itemLines[itemLines.length - 1] === '';
        // Only a paragraph continuation loses 4 more columns: a line that
        // follows a list marker is nested content and keeps its indent so
        // the recursive parse nests it (cm-294). A stripped line that would
        // start a block is marked lazy so it joins the open paragraph.
        if (!prevBlank && indentOf(s) >= 4) {
          const prev = itemLines.length ? itemLines[itemLines.length - 1] : '';
          if (prev !== '' && !parseMarker(prev) && !startsBlock(prev)) {
            s = stripIndent(s, 4);
            if (parseMarker(s) || startsBlock(s)) itemLazy.add(itemLines.length);
          }
        }
        // A blank line before a plain top-level block (not a nested list /
        // code / etc.) separates blocks, so this item is loose.
        itemLines.push(s);
        sawBlank = false;
        j++;
        continue;
      }
      if (itemLines.length && itemLines[itemLines.length - 1] !== '') {
        // A line starting a new block (HR, heading, fence, ...) ends the item.
        if (startsBlock(l)) break;
        // A setext underline cannot be a lazy continuation: indent it.
        if (/^ {0,3}=+[ \t]*$/.test(l)) {
          itemLazy.add(itemLines.length);
          itemLines.push('    ' + l.replace(/^[ \t]+/, ''));
          sawBlank = false;
          j++;
          continue;
        }
        // A blank line before a top-level (lazy) continuation line makes
        // this item loose; blanks before nested content do not.
        itemLazy.add(itemLines.length);
        itemLines.push(stripIndentExpand(l, contentIndent));
        sawBlank = false;
        j++;
        continue;
      }
      break;
    }
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    // A blank line followed by a non-blank line makes this item loose,
    // unless the following line belongs to a nested list that started
    // before the blank (a continuation line indented to that list's
    // content indent, or a marker of the same or a deeper list).
    for (let x = 1; x < itemLines.length - 1; x++) {
      if (itemLines[x] === '' && itemLines[x + 1] !== '') {
        const next = itemLines[x + 1];
        const nmNext = parseMarker(next);
        let nested = false;
        for (let m = 0; m < x; m++) {
          const pm = parseMarker(itemLines[m]);
          if (pm && (indentOf(next) >= pm.contentIndent || (nmNext && nmNext.base >= pm.base))) { nested = true; break; }
        }
        if (nested) continue;
        itemBlankInside = true;
      }
    }
    let task = false, checked = false;
    if (itemLines.length) {
      const tm = /^\[( |x|X)\][ \t]/.exec(itemLines[0]);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        itemLines[0] = itemLines[0].slice(4);
      }
    }
    // A link reference definition after a blank line counts as a second
    // block for looseness (cm-317), even though it renders nothing.
    let defBlock = false;
    for (let x = 1; x < itemLines.length; x++) {
      if (itemLines[x - 1] === '' && /^ {0,3}\[/.test(itemLines[x]) && tryDef(itemLines, x, Object.create(null))) { defBlock = true; break; }
    }
    const toks = tokenize(itemLines, refs, itemLazy);
    if ((toks.length >= 2 || defBlock) && itemBlankInside) loose = true;
    items.push({ task, checked, tokens: toks });
    if (j < lines.length && isBlank(lines[j - 1])) {
      let k = j;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length) {
        const nm2 = parseMarker(lines[k]);
        if (nm2 && (ordered ? (nm2.ordered && nm2.delim === delim) : (!nm2.ordered && nm2.marker === bullet))) loose = true;
      }
    }
    cur = null;
  }
  if (!items.length) return null;
  return {
    token: { t: 'list', ordered, start: startNum, items, loose },
    next: j,
  };
}

// ---------------- rendering ----------------
function render(tokens, refs, tight) {
  let out = '';
  for (const tk of tokens) {
    switch (tk.t) {
      case 'para': {
        const text = tk.text;
        out += tight ? inlineText(text, refs) : '<p>' + inlineText(text, refs) + '</p>\n';
        break;
      }
      case 'heading': {
        const inner = inlineText(tk.text.replace(/[ \t]+$/, ''), refs);
        out += '<h' + tk.level + '>' + inner + '</h' + tk.level + '>\n';
        break;
      }
      case 'code': {
        out += '<pre><code' + (tk.lang ? ' class="language-' + esc(tk.lang) + '"' : '') + '>' + escCode(tk.text) + '</code></pre>\n';
        break;
      }
      case 'html': {
        out += tk.lines.join('\n') + (tk.keepNl === false ? '' : '\n');
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'blockquote': {
        out += '<blockquote>\n' + render(tk.tokens, refs, false) + '</blockquote>\n';
        break;
      }
      case 'list': {
        out += tk.ordered ? '<ol' + (tk.start !== 1 ? ' start="' + tk.start + '"' : '') + '>\n' : '<ul>\n';
        for (const item of tk.items) {
          out += '<li>';
          if (item.task) out += item.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
          out += render(item.tokens, refs, !tk.loose);
          out += '</li>\n';
        }
        out += tk.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < tk.header.length; c++) {
          const a = tk.align[c];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineText(tk.header[c], refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tk.rows.length) {
          out += '<tbody>';
          for (const row of tk.rows) {
            out += '<tr>\n';
            for (let c = 0; c < tk.header.length; c++) {
              const a = tk.align[c];
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineText(row[c] === undefined ? '' : row[c], refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  return out;
}

export function parse(src) {
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const refs = Object.create(null);
  const tokens = tokenize(lines, refs);
  return render(tokens, refs, false);
}
