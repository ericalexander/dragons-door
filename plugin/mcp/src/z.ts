/**
 * Just enough of zod's interface for the game's tool arguments: each schema knows its JSON Schema (for
 * tools/list) and can parse a value (checking it and filling in defaults). Written here so the bundled
 * server stays small and readable; the game server checks every argument again anyway.
 */

type Json = Record<string, unknown>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export abstract class Schema<T = unknown> {
  protected desc?: string;
  isOptional = false;
  hasDefault = false;
  protected def?: unknown;

  abstract base(): Json;
  protected abstract check(v: unknown): Result<T>;

  json(): Json {
    return { ...this.base(), ...(this.desc ? { description: this.desc } : {}), ...(this.hasDefault ? { default: this.def } : {}) };
  }
  parse(v: unknown, path: string): Result<T | undefined> {
    if (v === undefined || v === null) {
      if (this.hasDefault) return { ok: true, value: this.def as T };
      if (this.isOptional) return { ok: true, value: undefined };
      return { ok: false, error: `${path} is required` };
    }
    const r = this.check(v);
    return r.ok ? r : { ok: false, error: `${path}: ${r.error}` };
  }
  optional(): this { const c = this.clone(); c.isOptional = true; return c; }
  default(d: T): this { const c = this.clone(); c.hasDefault = true; c.def = d; return c; }
  describe(d: string): this { const c = this.clone(); c.desc = d; return c; }
  protected clone(): this { return Object.assign(Object.create(Object.getPrototypeOf(this)), this); }
}

class StringSchema extends Schema<string> {
  private lo?: number;
  private hi?: number;
  min(n: number): this { const c = this.clone(); c.lo = n; return c; }
  max(n: number): this { const c = this.clone(); c.hi = n; return c; }
  base(): Json { return { type: "string", ...(this.lo !== undefined ? { minLength: this.lo } : {}), ...(this.hi !== undefined ? { maxLength: this.hi } : {}) }; }
  protected check(v: unknown): Result<string> {
    if (typeof v !== "string") return { ok: false, error: "expected a string" };
    if (this.lo !== undefined && v.length < this.lo) return { ok: false, error: `at least ${this.lo} characters` };
    if (this.hi !== undefined && v.length > this.hi) return { ok: false, error: `at most ${this.hi} characters` };
    return { ok: true, value: v };
  }
}

class NumberSchema extends Schema<number> {
  private whole = false;
  private lo?: number;
  private hi?: number;
  private above?: number;
  int(): this { const c = this.clone(); c.whole = true; return c; }
  min(n: number): this { const c = this.clone(); c.lo = n; return c; }
  max(n: number): this { const c = this.clone(); c.hi = n; return c; }
  positive(): this { const c = this.clone(); c.above = 0; return c; }
  base(): Json {
    return { type: this.whole ? "integer" : "number", ...(this.lo !== undefined ? { minimum: this.lo } : {}), ...(this.hi !== undefined ? { maximum: this.hi } : {}),
      ...(this.above !== undefined ? { exclusiveMinimum: this.above } : {}) };
  }
  protected check(v: unknown): Result<number> {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, error: "expected a number" };
    if (this.whole && !Number.isInteger(n)) return { ok: false, error: "expected a whole number" };
    if (this.lo !== undefined && n < this.lo) return { ok: false, error: `at least ${this.lo}` };
    if (this.hi !== undefined && n > this.hi) return { ok: false, error: `at most ${this.hi}` };
    if (this.above !== undefined && n <= this.above) return { ok: false, error: `more than ${this.above}` };
    return { ok: true, value: n };
  }
}

class BooleanSchema extends Schema<boolean> {
  base(): Json { return { type: "boolean" }; }
  protected check(v: unknown): Result<boolean> {
    if (typeof v === "boolean") return { ok: true, value: v };
    if (v === "true" || v === "false") return { ok: true, value: v === "true" };
    return { ok: false, error: "expected true or false" };
  }
}

class EnumSchema<T extends string> extends Schema<T> {
  constructor(private values: readonly T[]) { super(); }
  base(): Json { return { type: "string", enum: [...this.values] }; }
  protected check(v: unknown): Result<T> {
    return typeof v === "string" && (this.values as readonly string[]).includes(v) ? { ok: true, value: v as T } : { ok: false, error: `one of ${this.values.join(", ")}` };
  }
}

class LiteralSchema<T extends string | number | boolean> extends Schema<T> {
  constructor(private value: T) { super(); }
  base(): Json { return { type: typeof this.value, const: this.value }; }
  protected check(v: unknown): Result<T> { return v === this.value ? { ok: true, value: this.value } : { ok: false, error: `expected ${JSON.stringify(this.value)}` }; }
}

class UnionSchema extends Schema<unknown> {
  constructor(private options: Schema[]) { super(); }
  base(): Json { return { anyOf: this.options.map((o) => o.json()) }; }
  protected check(v: unknown): Result<unknown> {
    for (const o of this.options) { const r = o.parse(v, "value"); if (r.ok) return r; }
    return { ok: false, error: "didn't match any allowed form" };
  }
}

export type Shape = Record<string, Schema>;

/** JSON Schema for a tool's arguments. */
export function objectSchema(shape: Shape): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const [k, s] of Object.entries(shape)) {
    properties[k] = s.json();
    if (!s.isOptional && !s.hasDefault) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** Check a tool call's arguments against its shape, filling in defaults. Unknown keys are dropped. */
export function parseArgs(shape: Shape, args: unknown): Result<Record<string, unknown>> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(shape)) {
    const r = s.parse(a[k], k);
    if (!r.ok) return r;
    if (r.value !== undefined) out[k] = r.value;
  }
  return { ok: true, value: out };
}

export const z = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  enum: <T extends string>(values: readonly [T, ...T[]]) => new EnumSchema<T>(values),
  literal: <T extends string | number | boolean>(value: T) => new LiteralSchema<T>(value),
  union: (options: Schema[]) => new UnionSchema(options),
};
