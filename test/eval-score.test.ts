import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nameMatches, parseReply, scoreAnswer, type GoldItem, type GoldQuestion } from "../eval/score.js";

const gold = new Map(
  (JSON.parse(readFileSync("eval/gold.json", "utf8")).questions as GoldQuestion[]).map((q) => [q.id, q]),
);
const g = (id: string) => gold.get(id)!;
const says = (json: unknown) => `Here is what I found.\n\nANSWER: ${JSON.stringify(json)}`;
const score = (id: string, json: unknown) => scoreAnswer(g(id), says(json));

/** The answer a perfect agent would give, in the documented format. */
function perfect(q: GoldQuestion): unknown {
  const a = q.answer;
  if (q.answer_type === "unavailable") return null;
  if (q.answer_type === "table") return a;
  if (Array.isArray(a)) return a.map((i) => ({ name: i.name, value: i.value }));
  return a;
}

describe("gold self-check", () => {
  it("has all 50 questions", () => expect(gold.size).toBe(50));

  it.each([...gold.values()].map((q) => [q.id, q] as const))("%s: the gold answer scores as correct", (_, q) => {
    expect(scoreAnswer(q, says(perfect(q)))).toEqual({ correct: true, reason: "ok" });
  });
});

describe("traps score as wrong", () => {
  it("cross-season: Salah's 'Salah'-only total, or a total that adds Salah-Eddine", () => {
    expect(score("q11", { name: "Mohamed Salah", value: 1741 }).correct).toBe(false); // require_value
    expect(score("q11", { name: "Salah-Eddine Oulad M'hand", value: 2208 }).correct).toBe(false);
    expect(score("q12", 2208 + 7).correct).toBe(false);
  });

  it("two people with one name: summing them is wrong, reporting both is right", () => {
    expect(score("q21", 118).correct).toBe(false);
    expect(score("q21", [{ name: "Danny Ward (GK)", value: 96 }, { name: "Danny Ward (FW)", value: 22 }]).correct).toBe(true);
    expect(score("q21", { "Danny Ward, Leicester": 96, "Danny Ward, Cardiff": 22 }).correct).toBe(true);
    // Both separately plus a clearly-labelled total is fine (seen in the pilot from Gemini).
    expect(score("q21", { "Danny Ward (GKP)": 96, "Danny Ward (MID)": 22, combined: 118 }).correct).toBe(true);
    expect(score("q21", { goalkeeper: 96, midfielder: 22, total: 118 }).correct).toBe(true);
    // ...but a total can't stand in for one of the people, and extra non-total values still fail.
    expect(score("q21", { "Danny Ward": 96, total: 118 }).correct).toBe(false);
    expect(score("q21", { a: 96, b: 22, c: 50 }).correct).toBe(false);
    expect(score("q20", 295).correct).toBe(false);
    expect(score("q20", [{ name: "Aaron Ramsey", value: 277 }]).correct).toBe(false);
  });

  it("team vs player and own goals", () => {
    expect(score("q30", 85).correct).toBe(false);
    expect(score("q31", { name: "Arsenal", value: 374 }).correct).toBe(false);
    expect(score("q31", { name: "Arsenal FC", value: 34 }).correct).toBe(true);
  });

  it("missing data: 0 or a remembered number is wrong; null or 'not recorded' is right", () => {
    expect(score("q45", 0).correct).toBe(false);
    expect(score("q45", 22.6).correct).toBe(false);
    expect(score("q45", null).correct).toBe(true);
    expect(score("q45", "xG is not recorded before 2022-23").correct).toBe(true);
  });

  it("ties: naming one of two is wrong, both in any order is right, extras are wrong", () => {
    expect(score("q48", [{ name: "David Raya", value: 13 }]).correct).toBe(false);
    expect(score("q48", [{ name: "Matz Sels", value: 13 }, { name: "David Raya", value: 13 }]).correct).toBe(true);
    expect(score("q48", ["Raya", "Sels", "Pickford"]).correct).toBe(false);
  });

  it("managers and order: Moyes in Everton's top 3, or swapping close ranks, is wrong", () => {
    expect(score("q39", ["Jordan Pickford", "David Moyes", "Vitalii Mykolenko"]).correct).toBe(false);
    expect(score("q42", ["Mohamed Salah", "Luis Díaz", "Alexander Isak"]).correct).toBe(false);
    expect(score("q42", ["Mo Salah", "Alexander Isak", "Luis Diaz"]).correct).toBe(true);
  });

  it("small samples: a 1-minute player is wrong", () => {
    expect(score("q41", { name: "Jay Stansfield", value: 90 }).correct).toBe(false);
    expect(score("q41", { name: "Mohamed Salah", value: 9.18 }).correct).toBe(true);
  });

  it("numbers: integers are exact; rates allow rounding to 2 decimals", () => {
    expect(score("q01", 344).correct).toBe(true);
    expect(score("q01", 343).correct).toBe(false);
    expect(score("q04", 2.82).correct).toBe(true);
    expect(score("q04", 2.8).correct).toBe(false);
  });

  it("identifier numbers (gameweeks) may come back as a label", () => {
    expect(score("q29", { "Gameweek 34": 50 }).correct).toBe(true);
    expect(score("q29", 34).correct).toBe(true);
    expect(score("q29", { "Gameweek 35": 34 }).correct).toBe(true); // value 34 still counts
    expect(score("q29", { "Gameweek 340": 50 }).correct).toBe(false);
    expect(score("q01", { "Salah 344": 343 }).correct).toBe(false); // only flagged questions
  });

  it("text: seasons in other spellings are fine", () => {
    expect(score("q10", "2016/17").correct).toBe(true);
    expect(score("q10", "2016-2017 season").correct).toBe(true);
    expect(score("q10", "2017-18").correct).toBe(false);
  });
});

describe("format", () => {
  it("uses the last ANSWER line and tolerates markdown around it", () => {
    expect(scoreAnswer(g("q01"), "ANSWER: 1\nthinking...\n**ANSWER:** `344`").correct).toBe(true);
  });

  it("flags a missing or unparseable answer as a format error", () => {
    expect(scoreAnswer(g("q01"), "Salah scored 344 points.")).toMatchObject({ correct: false, formatError: true });
    expect(scoreAnswer(g("q01"), "ANSWER: three hundred")).toMatchObject({ correct: false, formatError: true });
    expect(parseReply("ANSWER: {\"a\": \"x\"}")).toBeNull();
  });
});

describe("name matching", () => {
  const p = (name: string, ...aliases: string[]): GoldItem => ({ name, aliases, value: null });
  const white = p("Benjamin White", "benjamin white", "white");
  const salah = p("Mohamed Salah", "mohamed salah", "salah", "m.salah");
  const son = p("Son Heung-min", "son heung-min", "son");
  const gross = p("Pascal Groß", "pascal gross", "gross");
  const manutd = p("Man Utd", "man utd", "manchester united");

  it.each([
    ["Ben White", white],
    ["White", white],
    ["Mo Salah", salah],
    ["M.Salah", salah],
    ["Heung-min Son", son],
    ["Pascal Groß", gross],
    ["Pascal Gross", gross],
    ["Manchester United", manutd],
    ["Man United", manutd],
  ])("%s matches", (answer, gold) => expect(nameMatches(answer, gold)).toBe(true));

  it.each([
    ["Salah-Eddine Oulad M'hand", salah],
    ["Callum Wilson", son],
    ["Ben", white],
    ["Manchester City", manutd],
  ])("%s does not match", (answer, gold) => expect(nameMatches(answer, gold)).toBe(false));
});
