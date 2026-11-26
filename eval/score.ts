/**
 * Grades an agent's final answer against eval/gold.json. Pure logic, no API calls.
 *
 * Every agent gets the same answer instructions (ANSWER_FORMAT below), with no hint about the
 * expected type, so the format can't leak that, e.g., there are two Danny Wards. The scorer then
 * accepts any reasonable shape and applies the rules per gold answer type.
 */

export const ANSWER_FORMAT = `End your reply with exactly one line of the form
ANSWER: <json>
where <json> is one of:
- a number, e.g. 344
- a string, e.g. "2024-25"
- null, if the data does not contain the answer
- a list of {"name": ..., "value": ...} for one or more players or teams (best first when it's a ranking)
- an object of label -> number for several labelled values, e.g. {"home": 7.4, "away": 6.6}`;

export interface GoldItem {
  name: string;
  aliases: string[];
  value: number | null;
  player_code?: number;
}

export interface GoldQuestion {
  id: string;
  question: string;
  answer_type: "number" | "text" | "entity" | "ranking" | "set" | "table" | "unavailable";
  answer: number | string | null | GoldItem[] | Record<string, number | null>;
  tags: string[];
  tolerance?: number;
  top?: number;
  require_value?: boolean;
}

export interface Score {
  correct: boolean;
  /** Why it was marked wrong (or "ok"). Useful when reading results. */
  reason: string;
  /** True when no parseable ANSWER line was found (a format failure, not a wrong answer). */
  formatError?: boolean;
}

interface Item {
  name?: string;
  value?: number | null;
}

type Parsed =
  | { kind: "null" }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "items"; items: Item[] };

// ------------------------------------------------------------------------------------------------

export function scoreAnswer(gold: GoldQuestion, reply: string): Score {
  const parsed = parseReply(reply);
  if (!parsed) return { correct: false, reason: "no parseable ANSWER line", formatError: true };
  return grade(gold, parsed);
}

/** Find the last `ANSWER: <json>` line and normalise it. */
export function parseReply(reply: string): Parsed | null {
  // Accepts "ANSWER: x", "**ANSWER**: x" and "**ANSWER:** x".
  const lines = [...reply.matchAll(/^\s*\**ANSWER\**:\**\s*(.+?)\s*$/gim)];
  const raw = lines.at(-1)?.[1]?.replace(/^`+|`+$/g, "");
  if (raw === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalise(v);
}

function normalise(v: unknown): Parsed | null {
  if (v === null) return { kind: "null" };
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (Array.isArray(v)) {
    const items = v.map(toItem);
    return items.every((i): i is Item => i !== null) ? { kind: "items", items } : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // {"name": ..., "value": ...} is one item; anything else is label -> value.
    if ("name" in o || "value" in o) {
      const i = toItem(o);
      return i ? { kind: "items", items: [i] } : null;
    }
    const items: Item[] = [];
    for (const [k, val] of Object.entries(o)) {
      if (val !== null && typeof val !== "number") return null;
      items.push({ name: k, value: val });
    }
    return { kind: "items", items };
  }
  return null;
}

function toItem(v: unknown): Item | null {
  if (typeof v === "string") return { name: v };
  if (typeof v === "number") return { value: v };
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : undefined;
  const value = typeof o.value === "number" ? o.value : o.value === null ? null : undefined;
  return name === undefined && value === undefined ? null : { name, value };
}

// ------------------------------------------------------------------------------------------------

function grade(g: GoldQuestion, a: Parsed): Score {
  const tol = (x: number) => g.tolerance ?? (Number.isInteger(x) ? 0 : 0.01);
  const near = (got: number | null | undefined, want: number | null) =>
    want === null ? got === null : typeof got === "number" && Math.abs(got - want) <= tol(want) + 1e-9;
  const ok = { correct: true, reason: "ok" };
  const wrong = (reason: string) => ({ correct: false, reason });
  const single = (): number | null | undefined =>
    a.kind === "number" ? a.value : a.kind === "items" && a.items.length === 1 ? a.items[0]!.value : undefined;

  switch (g.answer_type) {
    case "number": {
      const want = g.answer as number;
      const got = single();
      return near(got, want) ? ok : wrong(`expected ${want}, got ${JSON.stringify(got ?? a)}`);
    }

    case "unavailable": {
      const saysMissing =
        a.kind === "null" ||
        (a.kind === "items" && a.items.length === 1 && a.items[0]!.value === null) ||
        (a.kind === "string" && /not (available|recorded|in the data)|no data|unavailable|doesn't exist|does not exist/i.test(a.value));
      return saysMissing ? ok : wrong(`should say the data isn't available, got ${JSON.stringify(a)}`);
    }

    case "text": {
      const want = normText(String(g.answer));
      const got = a.kind === "string" ? a.value : a.kind === "items" && a.items.length === 1 ? a.items[0]!.name : undefined;
      return got !== undefined && normText(got) === want ? ok : wrong(`expected "${g.answer}", got ${JSON.stringify(got ?? a)}`);
    }

    case "entity": {
      const want = (g.answer as GoldItem[])[0]!;
      const first = itemsOf(a)[0];
      if (!first?.name || !nameMatches(first.name, want)) return wrong(`expected ${want.name}, got ${first?.name ?? JSON.stringify(a)}`);
      if (g.require_value && !near(first.value, want.value)) return wrong(`right name, but value ${first.value} != ${want.value}`);
      return ok;
    }

    case "ranking": {
      const want = g.answer as GoldItem[];
      const got = itemsOf(a);
      if (got.length < want.length) return wrong(`expected ${want.length} names, got ${got.length}`);
      for (let i = 0; i < want.length; i++) {
        if (!got[i]?.name || !nameMatches(got[i]!.name!, want[i]!)) {
          return wrong(`#${i + 1} should be ${want[i]!.name}, got ${got[i]?.name}`);
        }
      }
      return ok;
    }

    case "set": {
      const want = g.answer as GoldItem[];
      const got = itemsOf(a).filter((i) => i.name);
      const missing = want.filter((w) => !got.some((x) => nameMatches(x.name!, w)));
      const extra = got.filter((x) => !want.some((w) => nameMatches(x.name!, w)));
      if (missing.length) return wrong(`missing ${missing.map((m) => m.name).join(", ")}`);
      if (extra.length) return wrong(`unexpected ${extra.map((e) => e.name).join(", ")}`);
      return ok;
    }

    case "table": {
      const want = g.answer as Record<string, number | null>;
      const got = itemsOf(a);
      if (g.tags.includes("ambiguous_person")) {
        // Two people share the name: both values must be reported separately (labels are free-form).
        // An extra entry that is clearly a total (labelled so, or equal to the sum) is allowed as
        // long as the separate values are there; a lone summed number still fails.
        const values = Object.values(want);
        const sum = values.reduce<number>((s, v) => s + (v ?? 0), 0);
        const isTotal = (i: Item) => (i.name !== undefined && /\b(total|combined|sum|together|both)\b/i.test(i.name)) || near(i.value, sum);
        const pool = (got.length > values.length ? got.filter((i) => !isTotal(i)) : got).map((i) => i.value);
        if (pool.length !== values.length) return wrong(`expected ${values.length} separate people, got ${pool.length} value(s)`);
        for (const v of values) {
          const idx = pool.findIndex((p) => near(p, v));
          if (idx < 0) return wrong(`no value matching ${v} (got ${JSON.stringify(pool)})`);
          pool.splice(idx, 1);
        }
        return ok;
      }
      for (const [k, v] of Object.entries(want)) {
        const hit = got.find((i) => i.name && fold(i.name).includes(fold(k)));
        if (!hit) return wrong(`no value labelled "${k}"`);
        if (!near(hit.value, v)) return wrong(`"${k}" should be ${v}, got ${hit.value}`);
      }
      return ok;
    }
  }
}

function itemsOf(a: Parsed): Item[] {
  if (a.kind === "items") return a.items;
  if (a.kind === "string") return [{ name: a.value }];
  return [];
}

// ------------------------------------------------------------------------------------------------
// Names

/** Lowercase, strip accents, ß -> ss. */
export function fold(s: string): string {
  return s
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

const STOP = new Set(["fc", "afc", "the"]);
const tokens = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));

/**
 * Does an answer name refer to this gold player/team? True when, for some alias, every word of the
 * answer is a prefix of a word in the alias ("Ben White" ~ "Benjamin White") and at least one word
 * matches in full ("white"). So "Mo Salah" matches Mohamed Salah but "Salah-Eddine" does not.
 */
export function nameMatches(answer: string, gold: GoldItem): boolean {
  const words = tokens(answer);
  if (!words.length) return false;
  return gold.aliases.some((alias) => {
    const aw = tokens(alias);
    const allPrefix = words.every((w) => aw.some((x) => x.startsWith(w) || (w.length >= 3 && w.startsWith(x) && x.length >= 3)));
    const oneExact = words.some((w) => w.length >= 3 && aw.includes(w));
    return allPrefix && oneExact;
  });
}

/** Seasons as yyyy-yy, months as yyyy-mm; otherwise folded text. */
function normText(s: string): string {
  const t = fold(s).replace(/\s*season\s*/g, "");
  const season = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(t);
  if (season) return `${season[1]}-${season[2]!.slice(-2)}`;
  return t;
}
