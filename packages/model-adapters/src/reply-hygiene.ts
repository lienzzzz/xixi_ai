/**
 * Spoken-reply hygiene (t7): provider artifacts that must never reach a mouth.
 *
 * Two defects were caught on the real path and recorded in the V0.1 baseline
 * (`docs/benchmarks/v01-baseline.md` §4, 2026-09-30):
 *
 *  1. **Tool-call markup as the reply body.** With no tools wired up, the model put the
 *     call in its *text*: `<tool_call><function=get_weather><parameter=date>today</parameter>
 *     <parameter=city>上海</parameter></function></tool_call>` — 7 of 8 weather turns, and TTS read
 *     it out loud (原文 `docs/benchmarks/v01/raw-voice-batchA.txt`).
 *  2. **English self-reasoning as the reply.** One turn's body was ~600 characters of English
 *     reasoning that ended in the actual Chinese line (`raw-voice-batchB.txt`):
 *     “The user is repeating their earlier message … I should respond naturally as a family
 *     member would …都这么晚了，还没到家？到家了就早点歇着。”
 *
 * Why the fix lives here and not in the prompt: 铁律 1 puts boundaries in the program, and a
 * prompt revision (or a different provider) must not be able to make the household hear
 * protocol garbage or private English reasoning. Everything below is a pure function of the
 * text, so a turn replays byte-identically.
 *
 * What each layer owns:
 *   * `stripToolCallMarkup` — language-independent, so the *adapter* (the provider boundary) can
 *     use it on both the stream and the final text;
 *   * `sanitizeSpokenReply` — needs the configured language, so the *engine* owns it, together
 *     with the audit notice. A leak never reaches TTS, the transcript or working memory.
 *   * `createSpokenTextFilter` — the streaming seam: holds tool-call markup always, and (when the
 *     deployment speaks Chinese) holds a foreign *opening* until the first Han character decides
 *     whether it is an ordinary word or the start of the reasoning leak. Reasoning deeper in the
 *     reply is not judged per chunk: that needs the whole text, which `sanitizeSpokenReply` gates.
 */

/** One Han character. */
const HAN_CHAR = /\p{Script=Han}/u;
/** CJK punctuation, so a Chinese phrase stays one region across its commas and full stops. */
/**
 * CJK punctuation, written with escapes on purpose: a literal `''` here was previously matched as a
 * plain apostrophe, which turned `it's` into a "Chinese run" (t21). Quotes are handled separately by
 * `isQuote`, never absorbed into a Chinese run.
 */
const CJK_PUNCT =
  /[\u3001\u3002\uff01\uff1f\uff0c\uff1b\uff1a\u300c\u300d\u300e\u300f\uff08\uff09\u3014\u3015\u3010\u3011\u300a\u300b\u3008\u3009\u2026\u2014\u00b7\uff5e]/u;
/** Straight and typographic quotes: they delimit a *quotation*, which is not the speaker's own line. */
const QUOTE_CHARS = new Set(['"', '\u201c', '\u201d', '\u2018', '\u2019']);
const ASCII_LETTER = /[A-Za-z]/;

/** `<tool_call>` … `</tool_call>`, plus the `<|tool_call|>` spelling. */
const TOOL_CALL_OPEN = /<\s*\|?\s*tool_calls?\s*\|?\s*>/i;
const TOOL_CALL_CLOSE = /<\s*\/\s*\|?\s*tool_calls?\s*\|?\s*>/i;
/** The inner tags of the same markup: `<function=get_weather>`, `<parameter=city>`. */
const TOOL_CALL_INNER_TAG = /<\s*\/?\s*(?:function|parameter)\b[^>]*>/gi;
/**
 * A bare `<parameter=city>上海</parameter>` without its `<tool_call>` wrapper — a truncated stream
 * can leave exactly this. The **value** between the tags is a tool argument, never speech, so the
 * pair goes together.
 */
const TOOL_CALL_TAG_PAIR = /<\s*(?:function|parameter)\b[^>]*>[\s\S]*?<\s*\/\s*(?:function|parameter)\s*>/gi;

/**
 * Anything a streaming chunk may be in the middle of. A chunk that ends with `<`, `<tool_ca`
 * or `<|tool_call|` must not be spoken before the rest arrives, or the marker leaks a piece
 * at a time — the same reasoning as the silence-token hold in the engine (§55).
 */
const MARKER_PREFIXES = [
  '<tool_call>',
  '<tool_calls>',
  '<|tool_call|>',
  '<|tool_calls|>',
  '</tool_call>',
  '</tool_calls>',
  '<function',
  '<parameter',
];

/** A held block longer than this is treated as an unterminated one instead of buffering a turn. */
const MAX_HOLD_CHARS = 2000;

/** Minimum ASCII letters before a sentence can count as a foreign (reasoning) block. */
const FOREIGN_MIN_LETTERS = 20;
/** …or, without a reasoning cue, how long it has to be to be obvious anyway. */
const FOREIGN_LONG_LETTERS = 60;

/**
 * Meta-talk that only appears in a model's private reasoning, never in something a household
 * member says. Keep it about *reasoning*, not about topics: a legit English sentence (“Sure,
 * no problem.”) must survive.
 */
const REASONING_CUE =
  /\b(?:the user|the conversation|i should|i need to|i'll respond|i will respond|let me|maybe i|so they|they're saying|they are saying|my response|respond naturally|repeated message)\b/i;

export interface ReplyHygieneResult {
  /** What may be spoken; empty when the whole reply was an artifact. */
  readonly text: string;
  /** Total characters taken out (markup + markdown + reasoning), for the audit note. */
  readonly removedChars: number;
  /** Tool-call markup (a provider protocol artifact). */
  readonly removedMarkupChars: number;
  /** Markdown decorations that a TTS would have read out loud (`**`, `- `, `#`). */
  readonly removedMarkdownChars: number;
  readonly removedReasoningChars: number;
}

export interface SpokenReplyOptions {
  /** The configured reply language (`config.xixi.identity.language`, e.g. `zh-CN`). */
  readonly language?: string;
}

/** True for a Chinese-language deployment (the default when the caller does not say). */
export function isChineseLanguage(language: string | undefined): boolean {
  return (language ?? 'zh').toLowerCase().startsWith('zh');
}

/**
 * Remove tool-call markup from a reply.
 *
 * Two shapes are covered: a complete `<tool_call>…</tool_call>` block (including its inner
 * `<function=…>`/`<parameter=…>` tags), and an **unterminated** block — a stream cut inside
 * the markup must not leave half a tag to be spoken.
 */
export function stripToolCallMarkup(text: string): { readonly text: string; readonly removedChars: number } {
  let removedChars = 0;
  let rest = text;
  let kept = '';
  for (;;) {
    const open = TOOL_CALL_OPEN.exec(rest);
    if (open === null) {
      kept += rest;
      break;
    }
    kept += rest.slice(0, open.index);
    const body = rest.slice(open.index + open[0].length);
    const close = TOOL_CALL_CLOSE.exec(body);
    if (close === null) {
      // Unterminated: everything from the marker on is protocol, not speech.
      removedChars += rest.length - open.index;
      break;
    }
    removedChars += open[0].length + close.index + close[0].length;
    rest = body.slice(close.index + close[0].length);
  }
  const withoutPairs = kept.replace(TOOL_CALL_TAG_PAIR, (match) => {
    removedChars += match.length;
    return '';
  });
  const withoutStrays = withoutPairs.replace(TOOL_CALL_INNER_TAG, (match) => {
    removedChars += match.length;
    return '';
  });
  return { text: tidy(withoutStrays), removedChars };
}

/**
 * Remove foreign (English) reasoning from a Chinese reply.
 *
 * Reasoning is a *block* property, not a sentence one: the leaked sample's English body is many
 * ordinary-looking sentences ("But it's currently 23:30 at night…", "So they're probably already
 * back…"), so judging sentence by sentence keeps most of it. A paragraph that is foreign-dominant
 * is therefore removed as a whole; inside a kept paragraph only a sentence with an explicit
 * reasoning cue (t7) is removed, so a Chinese sentence merely containing an English word stays.
 *
 * A removed block that still ends with Chinese keeps that tail — the baseline sample is exactly
 * this shape (“…asking if they got back okay.都这么晚了，还没到家？到家了就早点歇着。”).
 */
export function stripForeignReasoning(text: string): { readonly text: string; readonly removedChars: number } {
  let removedChars = 0;
  let kept = '';
  for (const block of text.split(/(\n)/)) {
    if (block === '\n') {
      kept += block;
      continue;
    }
    if (isReasoningBlock(block)) {
      // t21 (from the t12 review's O1): a reasoning block may still contain the *answer* — the model
      // writes a Chinese sentence, reasons in English, then answers in Chinese. Keeping only the
      // trailing Chinese run deleted 「嗯，我在的。」 and 「明天多云…」 along with the reasoning. What is
      // kept instead is every **unquoted** Chinese part of the block; a Chinese quotation inside the
      // reasoning (the user's own words, `they said "今天下午…"`) stays dropped.
      const keptFromBlock = sentenceUnits(block).map((unit) => unquotedChineseRuns(unit)).join('').trim();
      removedChars += block.length - keptFromBlock.length;
      kept += keptFromBlock;
      continue;
    }
    for (const unit of sentenceUnits(block)) {
      if (!isReasoningUnit(unit)) {
        kept += unit;
        continue;
      }
      const tail = trailingChineseTail(unit);
      removedChars += unit.length - tail.length;
      kept += tail;
    }
  }
  return { text: tidy(kept), removedChars };
}

/**
 * The Chinese content of one sentence, with anything inside ASCII quotes removed.
 *
 * A run starts at a Han character (or CJK punctuation) and absorbs everything that is not an ASCII
 * letter — digits, spaces, `，`, `。` — so 「明天多云，12 到 20 度」 comes through whole, while the
 * English around it does not.
 */
function unquotedChineseRuns(sentence: string): string {
  let kept = '';
  let run = '';
  let inQuotes = false;
  const flush = (): void => {
    kept += run;
    run = '';
  };
  for (const char of sentence) {
    if (isQuote(char)) {
      inQuotes = !inQuotes;
      flush();
      continue;
    }
    // A run must *start* on Chinese text; once started it absorbs digits, spaces and punctuation
    // (so 「明天多云，12 到 20 度」 survives whole) but never an ASCII letter.
    const startsRun = HAN_CHAR.test(char) || CJK_PUNCT.test(char);
    if (!inQuotes && (startsRun || (run.length > 0 && !ASCII_LETTER.test(char)))) run += char;
    else flush();
  }
  flush();
  return kept;
}

function isQuote(char: string): boolean {
  return QUOTE_CHARS.has(char);
}

/**
 * Remove markdown decorations a mouth would read out loud (t21, from the t4 verification's F3:
 * "朗读时会出现星号星号").
 *
 * A knowledge answer that comes back as a bulleted, bolded list is *text* markup, not speech:
 * `- **别硬躺**。` must be spoken as 「别硬躺。」. Only decorations go — the words stay, and nothing
 * here decides what she may say. Sentence enders are kept so the segmenter still sees sentence
 * boundaries (the newlines themselves are dropped later by `normalizeReplyText`).
 */
export function stripMarkdownDecorations(text: string): { readonly text: string; readonly removedChars: number } {
  let removed = 0;
  const drop = (match: string, keep: string): string => {
    removed += match.length - keep.length;
    return keep;
  };
  const withoutMarkup = text
    // `**粗体**` / `__粗体__` / `*斜体*` / `` `代码` ``
    .replace(/\*\*([^*\n]+)\*\*/g, (match, inner: string) => drop(match, inner))
    .replace(/__([^_\n]+)__/g, (match, inner: string) => drop(match, inner))
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (match, lead: string, inner: string) => drop(match, `${lead}${inner}`))
    .replace(/`([^`\n]+)`/g, (match, inner: string) => drop(match, inner))
    // line-leading decorations: headings, bullets, ordered-list numbers
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, (match) => drop(match, ''))
    .replace(/^[ \t]*[-*+•][ \t]+/gm, (match) => drop(match, ''))
    .replace(/^[ \t]*\d{1,2}[.、)][ \t]+/gm, (match) => drop(match, ''))
    // a markdown table's separator row (`|---|---|`) is pure punctuation
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, (match) => drop(match, ''));
  return { text: withoutMarkup, removedChars: removed };
}

/**
 * The deterministic gate: markup always goes, markdown decorations go (they are read out loud),
 * and foreign reasoning goes when the deployment speaks Chinese. Callers must speak `text` and
 * never the input.
 */
export function sanitizeSpokenReply(text: string, options: SpokenReplyOptions = {}): ReplyHygieneResult {
  const markup = stripToolCallMarkup(text);
  const markdown = stripMarkdownDecorations(markup.text);
  const reasoning = isChineseLanguage(options.language)
    ? stripForeignReasoning(markdown.text)
    : { text: markdown.text, removedChars: 0 };
  return {
    text: reasoning.text,
    removedChars: markup.removedChars + markdown.removedChars + reasoning.removedChars,
    removedMarkupChars: markup.removedChars,
    removedMarkdownChars: markdown.removedChars,
    removedReasoningChars: reasoning.removedChars,
  };
}

export interface SpokenTextFilter {
  /** Text that is safe to speak right now (may be empty while a marker is still open). */
  push(chunk: string): string;
  /** Whatever is left when the stream ends, already stripped of markup and of a foreign opening. */
  flush(): string;
}

/** A leading ASCII run shorter than this is an ordinary opening word (`OK，…`), not a preamble. */
const FOREIGN_PREAMBLE_MIN_LETTERS = 40;
/** How much an undecided opening may buffer before it is judged by its length alone. */
const LEADING_MAX_CHARS = 2000;
/**
 * t21: how much Han-free text may accumulate **after** the reply has started before it is given up
 * on and treated as reasoning. The observed leak was ~60 characters; 600 leaves room for quoted
 * English inside a Chinese sentence without holding a whole turn.
 */
const MID_REPLY_HOLD_MAX = 600;

/**
 * The streaming seam's hold, for a TTS driven by deltas.
 *
 * Nothing is ever spoken and then retracted — the whole point of this class (t21, from the t12
 * review's F1: "delta 出口先吐后撤"). Three things are held back:
 *   * **tool-call markup** — buffered from the first possible marker until the block closes (or the
 *     hold overflows, or the stream ends);
 *   * **a leading foreign opening** — when the deployment speaks Chinese, an English preamble may
 *     turn out to be the reasoning leak, so the opening is held until the first Han character
 *     arrives; a short opening word (`OK，…`) is then spoken as-is, a long English preamble is
 *     dropped and only the Chinese behind it is spoken;
 *   * **a mid-reply foreign run** (t21) — after the reply has started, text is released only up to
 *     the **last Han character seen so far**. Everything after it (English clauses, punctuation) is
 *     kept back until the next Han character proves it was a quotation or an aside, and reasoning is
 *     dropped from that window *before* it is ever emitted. Han-free text that overruns
 *     `MID_REPLY_HOLD_MAX` is treated the same way the leading rule treats a long English opening:
 *     dropped, and the filter resumes at the next unquoted Han character.
 *
 * `options.language` decides what counts as foreign: the last two rules run when the deployment
 * speaks Chinese, which is what `isChineseLanguage` reads an omitted option as (`zh`). Omitting it is
 * therefore **not** a pass-through: the Chinese rules would apply to every deployment, and one that
 * speaks something else would have its own long non-Chinese runs held back or dropped as if they were
 * reasoning. Pass the configured language so the hold follows the deployment (t14/T5-F3 — the wording
 * here used to promise a pass-through leak this function never had).
 */
export function createSpokenTextFilter(options: SpokenReplyOptions = {}): SpokenTextFilter {
  const holdForeign = isChineseLanguage(options.language);
  let buffer = '';
  let leading = holdForeign;
  let pending = '';
  let tail = '';
  let dropping = false;
  /**
   * While the reply is being dropped as reasoning, an ASCII-quoted Chinese phrase is *quoted*, not
   * spoken: the baseline sample reasons about the user's words (`they said "今天下午去镇上办点事…"`)
   * before it says its own line. Quoting state has to survive chunks, hence the flag.
   */
  let inQuotes = false;

  const resumeAtChinese = (text: string): string => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string;
      if (isQuote(char)) {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && HAN_CHAR.test(char)) {
        dropping = false;
        return text.slice(index);
      }
    }
    return '';
  };

  const consume = (text: string): string => {
    if (!holdForeign) return text;
    if (dropping) return resumeAtChinese(text);
    if (leading) {
      pending += text;
      const hanAt = firstHanIndex(pending);
      if (hanAt === -1) {
        if (pending.length > LEADING_MAX_CHARS && statsOf(pending).letters >= FOREIGN_PREAMBLE_MIN_LETTERS) {
          pending = '';
          dropping = true;
          inQuotes = false;
        }
        return '';
      }
      const preamble = pending.slice(0, hanAt);
      const rest = pending.slice(hanAt);
      pending = '';
      leading = false;
      if (statsOf(preamble).letters >= FOREIGN_PREAMBLE_MIN_LETTERS) {
        // The opening is the reasoning leak: drop the rest of it too, and resume at the first Chinese
        // that is not a quotation of the user's own words.
        dropping = true;
        inQuotes = seedQuotes(preamble);
        return resumeAtChinese(rest);
      }
      const head = preamble + rest;
      return head.length === 0 ? '' : release(head);
    }
    return release(text);
  };

  /**
   * t21: release only what cannot still turn out to be reasoning — up to the last Han character.
   * Whatever follows it stays in `tail` until another Han character (or the end of the stream)
   * decides it.
   */
  const release = (text: string): string => {
    tail += text;
    const lastHan = lastHanIndex(tail);
    if (lastHan === -1) {
      if (tail.length > MID_REPLY_HOLD_MAX) {
        // A long Han-free stretch mid-reply is the reasoning leak: drop it and wait for Chinese.
        tail = '';
        dropping = true;
        inQuotes = false;
      }
      return '';
    }
    const window = tail.slice(0, lastHan + 1);
    tail = tail.slice(lastHan + 1);
    // Reasoning inside the window was never emitted, so dropping it here is not a retraction.
    return stripForeignReasoning(window).text;
  };

  return {
    push(chunk: string): string {
      buffer += chunk;
      if (buffer.length > MAX_HOLD_CHARS) {
        // An unterminated block must not buffer a whole turn.
        const stripped = stripToolCallMarkup(buffer);
        buffer = '';
        return consume(stripped.text);
      }
      for (;;) {
        const cut = markupBoundary(buffer);
        if (cut > 0) {
          const emit = buffer.slice(0, cut);
          buffer = buffer.slice(cut);
          return consume(emit);
        }
        // The buffer starts a marker (or a prefix of one). A *closed* block is dropped right here, so
        // the sentence behind it is not delayed until the end of the turn; anything else keeps waiting.
        const open = TOOL_CALL_OPEN.exec(buffer);
        if (open === null || open.index !== 0) return '';
        const close = TOOL_CALL_CLOSE.exec(buffer.slice(open[0].length));
        if (close === null) return '';
        buffer = buffer.slice(open[0].length + close.index + close[0].length);
      }
    },
    flush(): string {
      const stripped = stripToolCallMarkup(buffer);
      buffer = '';
      const emitted = consume(stripped.text);
      if (!holdForeign) return emitted;
      if (dropping) {
        const resumed = resumeAtChinese(emitted);
        dropping = false; // the stream ended: there is nothing left to drop
        return resumed;
      }
      if (leading && pending.length > 0) {
        // The stream ended while the opening was still undecided: a short English line is a reply,
        // a long one is the reasoning leak.
        const text = statsOf(pending).letters >= FOREIGN_PREAMBLE_MIN_LETTERS ? '' : pending;
        pending = '';
        leading = false;
        return emitted + tidyTail(text);
      }
      return emitted + tidyTail(tail);
    },
  };
}

/** At the end of the stream the held tail is Han-free: short punctuation stays, a long run is reasoning. */
function tidyTail(text: string): string {
  if (text.length === 0) return '';
  return statsOf(text).letters >= FOREIGN_PREAMBLE_MIN_LETTERS ? '' : text;
}

function lastHanIndex(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (HAN_CHAR.test(text[index] as string)) return index;
  }
  return -1;
}

function firstHanIndex(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (HAN_CHAR.test(text[index] as string)) return index;
  }
  return -1;
}

/** Whether an ASCII double quote is open after reading `text` (quotation state survives chunks). */
function seedQuotes(text: string): boolean {
  let open = false;
  for (const char of text) if (char === '"') open = !open;
  return open;
}

// ------------------------------------------------------------------ internals

/**
 * Split into sentence units, keeping their enders, so joining the kept units reproduces the
 * original wording. A `.` only ends a unit when a space or the end of the text follows it —
 * otherwise “okay.都这么晚了” would be torn apart before the rule can look at it.
 */
function sentenceUnits(text: string): string[] {
  const units: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    current += char;
    const next = text[index + 1];
    const endsAsciiSentence = (char === '.' || char === '!' || char === '?') && (next === undefined || /\s/.test(next));
    if ('。！？…'.includes(char) || endsAsciiSentence || char === '\n') {
      units.push(current);
      current = '';
    }
  }
  if (current.length > 0) units.push(current);
  return units;
}

function isReasoningUnit(unit: string): boolean {
  const { letters, han } = statsOf(unit);
  if (letters < FOREIGN_MIN_LETTERS) return false;
  if (letters < 3 * han) return false; // not foreign-dominant: a Chinese sentence with an English word is fine
  return REASONING_CUE.test(unit);
}

/**
 * A whole paragraph of reasoning: foreign-dominant *and* either carrying a reasoning cue, long
 * enough to be nobody's chat line, or mixed with so little Chinese that the Chinese cannot be what
 * the paragraph is saying. A short pure-English line ("Sure, no problem.") is none of those.
 */
function isReasoningBlock(block: string): boolean {
  const { letters, han } = statsOf(block);
  if (letters < FOREIGN_MIN_LETTERS) return false;
  if (letters < 3 * han) return false;
  if (REASONING_CUE.test(block)) return true;
  if (letters >= FOREIGN_LONG_LETTERS) return true;
  return han > 0 && letters >= 5 * han;
}

/**
 * The Chinese region a reasoning unit ends with, when there is one: the last run of Han
 * characters *and their punctuation* (so “都这么晚了，还没到家？” is one region, not three).
 * Accepted only when it is really Chinese-dominant — otherwise it is just a quotation inside
 * the reasoning and goes with it.
 */
function trailingChineseTail(unit: string): string {
  let start = -1;
  for (let index = 0; index < unit.length; index += 1) {
    const char = unit[index] as string;
    if (!isCjkish(char)) continue;
    if (index === 0 || !isCjkish(unit[index - 1] as string)) start = index;
  }
  if (start < 0) return '';
  const tail = unit.slice(start);
  const { letters, han } = statsOf(tail);
  return han >= 4 && letters < han ? tail : '';
}

function isCjkish(char: string): boolean {
  return HAN_CHAR.test(char) || CJK_PUNCT.test(char);
}

function statsOf(text: string): { readonly letters: number; readonly han: number } {
  let letters = 0;
  let han = 0;
  for (const char of text) {
    if (HAN_CHAR.test(char)) han += 1;
    else if (ASCII_LETTER.test(char)) letters += 1;
  }
  return { letters, han };
}

/** The earliest index at which tool-call markup may begin (or already begins). */
function markupBoundary(buffer: string): number {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== '<') continue;
    const tail = buffer.slice(index).toLowerCase();
    if (MARKER_PREFIXES.some((marker) => marker.startsWith(tail) || tail.startsWith(marker))) return index;
  }
  return buffer.length;
}

/** Collapse what a removal leaves behind, and refuse to hand back punctuation-only "speech". */
function tidy(text: string): string {
  const collapsed = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(?=[，。！？；：、])/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s，。！？；：、,;:.]+/u, '')
    .trim();
  return /^[\s\p{P}\p{S}]*$/u.test(collapsed) ? '' : collapsed;
}
