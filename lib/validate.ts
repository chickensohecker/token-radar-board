// validate.ts — a self-check for the board this radar builds, run before anything is handed in.
//
// The gate refuses a board that breaks any of its shape rules, so this module re-checks
// those rules here, inside the entry, while a run is still cheap to stop. It only reads:
// it never changes a row, never reorders anything, and never writes a file. When it finds
// a problem it says so in plain words, and the entrypoint stops with a non-zero exit, so a
// bad board can never be shipped by accident.
//
// Two exports cover the two things the entry writes that the gate scores:
//   checkBoard   — the rows themselves: how many there are, whether their ranks run
//                  1..N with no gaps or repeats, whether implied value falls as rank
//                  rises, whether every row's farm plan is shaped right, and whether
//                  every protocol on the watchlist shows up.
//   checkDossier — the dossier text: it must be byte-for-byte the text the vendored
//                  library builds from the same output directory, and it must stay
//                  under its size cap.
//
// The numbers below are the gate's own caps, written out here so the check and the gate
// can never drift apart silently: if the gate ever moves a cap, this file is the one
// place that has to move with it.

/** The smallest piece of a row this module looks at. Extra fields ride along untouched. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** One human-readable complaint. An empty list means the board passed. */
export type BoardProblems = string[];

// --- The gate's caps, in one place. ---

/** A board holds at least this many rows and at most this many. */
const MIN_ROWS = 100;
const MAX_ROWS = 4000;
/** board.json may not pass this many bytes. */
const MAX_BOARD_BYTES = 8 * 1024 * 1024;
/** No implied value may pass this many dollars. */
const MAX_IMPLIED_USD = 100_000_000_000_000;
/** A farm plan holds at least this many steps and at most this many. */
const MIN_FARM_STEPS = 3;
const MAX_FARM_STEPS = 12;
/** One farm step, once trimmed, holds at least this many characters and at most this many. */
const MIN_STEP_CHARS = 20;
const MAX_STEP_CHARS = 600;
/** A slug is at most this many characters, with no whitespace anywhere in it. */
const MAX_SLUG_CHARS = 128;
/** dossier.json may not pass this many bytes (1.5 MiB). */
const MAX_DOSSIER_BYTES = 1_572_864;

/** A slug is one unbroken run of non-whitespace characters, within its length cap. */
const SLUG_SHAPE = /^[^\s]{1,128}$/;

// --- Small helpers. ---

/** True when the value is a finite whole number (no fractions, no NaN, no infinities). */
function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

/** True when the value is a string with at least one non-whitespace character in it. */
function isNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** How many UTF-8 bytes a string takes. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The first few items of a list, for a complaint that should stay short. */
function firstFew(items: string[], atMost: number): string {
  const shown = items.slice(0, atMost);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

// --- The board check. ---

/**
 * Look over a built board and return every problem with it, in plain words.
 *
 * `rows` is the board the model just built, `watchlist` is the snapshot's own list of
 * slugs the board must cover, and `knownSlugs` — when given — is the set of slugs the
 * snapshot actually lists, so an invented slug is caught too. An empty return means
 * the board is shaped the way the gate wants it. Nothing here mutates the rows.
 */
export function checkBoard(rows: BoardRow[], watchlist: string[], knownSlugs?: Set<string>): BoardProblems {
  const problems: BoardProblems = [];
  const note = (message: string): void => {
    problems.push(message);
  };

  if (!Array.isArray(rows)) {
    note('the board is not a list of rows');
    return problems;
  }

  // How many rows there are, before anything else: every later check assumes a list.
  if (rows.length < MIN_ROWS) {
    note(`the board holds ${rows.length} rows, fewer than the ${MIN_ROWS} the gate needs`);
  }
  if (rows.length > MAX_ROWS) {
    note(`the board holds ${rows.length} rows, more than the ${MAX_ROWS} the gate allows`);
  }
  if (rows.length === 0) return problems;

  // One pass over the rows, checking each row's own shape.
  const seenSlugs = new Set<string>();
  const repeatedSlugs: string[] = [];
  const inventedSlugs: string[] = [];
  const badNames: string[] = [];
  const badRanks: string[] = [];
  const badValues: string[] = [];
  const badPlans: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const where = `row ${i + 1} (${typeof row?.slug === 'string' ? row.slug : 'no slug'})`;

    if (!isNonBlankText(row.slug) || !SLUG_SHAPE.test(row.slug) || row.slug.length > MAX_SLUG_CHARS) {
      note(`${where} has a slug that is not one unbroken run of 1 to ${MAX_SLUG_CHARS} characters`);
    } else if (seenSlugs.has(row.slug)) {
      repeatedSlugs.push(row.slug);
    } else {
      seenSlugs.add(row.slug);
    }
    if (knownSlugs !== undefined && typeof row.slug === 'string' && !knownSlugs.has(row.slug)) {
      inventedSlugs.push(row.slug);
    }

    if (!isNonBlankText(row.name)) {
      badNames.push(where);
    }
    if (!isWholeNumber(row.rank) || row.rank < 1) {
      badRanks.push(where);
    }
    if (!isWholeNumber(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > MAX_IMPLIED_USD) {
      badValues.push(where);
    }

    if (!Array.isArray(row.farm_steps)) {
      badPlans.push(`${where} has no farm plan list`);
      continue;
    }
    if (row.farm_steps.length < MIN_FARM_STEPS || row.farm_steps.length > MAX_FARM_STEPS) {
      badPlans.push(`${where} carries ${row.farm_steps.length} farm steps, outside ${MIN_FARM_STEPS} to ${MAX_FARM_STEPS}`);
      continue;
    }
    for (let s = 0; s < row.farm_steps.length; s++) {
      const step = row.farm_steps[s]!;
      if (typeof step !== 'string') {
        badPlans.push(`${where} step ${s + 1} is not text`);
        continue;
      }
      const trimmed = step.trim().length;
      if (trimmed < MIN_STEP_CHARS || trimmed > MAX_STEP_CHARS) {
        badPlans.push(`${where} step ${s + 1} is ${trimmed} characters once trimmed, outside ${MIN_STEP_CHARS} to ${MAX_STEP_CHARS}`);
      }
    }
  }

  // Summaries of the per-row complaints, so one bad field does not flood the report.
  if (repeatedSlugs.length > 0) {
    note(`these slugs appear on more than one row: ${firstFew(repeatedSlugs, 5)}`);
  }
  if (inventedSlugs.length > 0) {
    note(`these slugs are not in the snapshot at all: ${firstFew(inventedSlugs, 5)}`);
  }
  if (badNames.length > 0) {
    note(`${badNames.length} row(s) have a blank or missing name, first at ${badNames[0]}`);
  }
  if (badRanks.length > 0) {
    note(`${badRanks.length} row(s) have a rank that is not a positive whole number, first at ${badRanks[0]}`);
  }
  if (badValues.length > 0) {
    note(`${badValues.length} row(s) have an implied value that is not a positive whole number under the cap, first at ${badValues[0]}`);
  }
  if (badPlans.length > 0) {
    note(`${badPlans.length} farm-plan problem(s), first: ${badPlans[0]}`);
  }

  // The ranks must be exactly 1..N, each once: no gaps, no repeats, no zeros.
  const ranks = rows
    .map((row) => row.rank)
    .filter((rank) => isWholeNumber(rank))
    .sort((a, b) => a - b);
  if (ranks.length === rows.length) {
    for (let n = 0; n < ranks.length; n++) {
      if (ranks[n] !== n + 1) {
        note(`the ranks are not exactly 1 to ${rows.length}: rank ${n + 1} is missing or repeated (found ${ranks[n]} where ${n + 1} belongs)`);
        break;
      }
    }
  }

  // Implied value must not rise as rank ascends: rank 1 is the most valuable row.
  // Only rows with a usable rank and value take part, so one bad row cannot hide
  // a broken ordering in the rest.
  const ranked = rows
    .filter((row) => isWholeNumber(row.rank) && isWholeNumber(row.implied_value_usd))
    .sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ranked.length; i++) {
    const prev = ranked[i - 1]!;
    const curr = ranked[i]!;
    if (curr.implied_value_usd > prev.implied_value_usd) {
      note(
        `implied value rises with rank: rank ${curr.rank} (${curr.slug}) is worth $${curr.implied_value_usd}, ` +
          `more than rank ${prev.rank} (${prev.slug}) at $${prev.implied_value_usd}`,
      );
      break;
    }
  }

  // A board whose every implied value is the same ranks nothing by value.
  if (ranked.length >= 2) {
    const firstValue = ranked[0]!.implied_value_usd;
    const allSame = ranked.every((row) => row.implied_value_usd === firstValue);
    if (allSame) {
      note(`every row carries the same implied value ($${firstValue}), so the board ranks nothing by value`);
    }
  }

  // The watchlist is a floor the board must cover in full, not a suggestion.
  if (Array.isArray(watchlist)) {
    const missing = watchlist.filter((slug) => !seenSlugs.has(slug));
    if (missing.length > 0) {
      note(`the watchlist is not fully covered: ${missing.length} protocol(s) missing, first ${firstFew(missing, 5)}`);
    }
  } else {
    note('the watchlist given to this check is not a list of slugs');
  }

  // The board file itself has a size cap, measured as the JSON the entry writes.
  const boardBytes = utf8Bytes(`${JSON.stringify({ rows })}\n`);
  if (boardBytes > MAX_BOARD_BYTES) {
    note(`the board file would be ${boardBytes} bytes, past the ${MAX_BOARD_BYTES} the gate allows`);
  }

  return problems;
}

// --- The dossier check. ---

/**
 * Compare the dossier the entry just wrote against a freshly built one.
 *
 * The vendored library hands the dossier back as raw bytes (a Uint8Array), not as a
 * string, because the file carries the screenshots' own bytes inside it: measuring it
 * as text would miscount it. So both sides are compared byte for byte here. `written`
 * is what went into dossier.json and `rebuilt` is what the library builds from the
 * same output directory right now; the two must agree on every byte, or the file on
 * disk is stale, the library is not deterministic, or something changed the output
 * between the two builds. The size cap is checked too. An empty list means the dossier
 * is exactly the library's own bytes.
 */
export function checkDossier(written: string | Uint8Array, rebuilt: string | Uint8Array): BoardProblems {
  const problems: BoardProblems = [];
  const writtenBytes = toRawBytes(written);
  const rebuiltBytes = toRawBytes(rebuilt);

  if (!sameBytes(writtenBytes, rebuiltBytes)) {
    problems.push(
      `the dossier on disk is not the dossier the library builds now: ` +
        `the written bytes are ${writtenBytes.length} and the fresh build is ${rebuiltBytes.length}`,
    );
    // Point at the first byte where they part, so a stale file is easy to find by eye.
    let at = 0;
    const shared = Math.min(writtenBytes.length, rebuiltBytes.length);
    while (at < shared && writtenBytes[at] === rebuiltBytes[at]) at++;
    problems.push(`the two dossiers first differ at byte ${at} of ${Math.max(writtenBytes.length, rebuiltBytes.length)}`);
  }
  if (writtenBytes.length > MAX_DOSSIER_BYTES) {
    problems.push(`the dossier is ${writtenBytes.length} bytes, past the ${MAX_DOSSIER_BYTES} the gate allows`);
  }
  return problems;
}

/** The raw bytes of a value the library may hand back as text or as a byte array. */
function toRawBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

/** True when two byte arrays hold exactly the same bytes, in the same order. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
