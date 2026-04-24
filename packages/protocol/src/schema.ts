export type ParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface Schema<T> {
  readonly parse: (input: unknown, path?: string) => ParseResult<T>;
  readonly is: (input: unknown) => input is T;
}

type Shape = Record<string, Schema<unknown>>;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string): ParseResult<T> {
  return { ok: false, error: message };
}

function at(path: string | undefined, fallback: string): string {
  return path && path.length > 0 ? path : fallback;
}

export function createSchema<T>(
  parse: (input: unknown, path?: string) => ParseResult<T>,
): Schema<T> {
  return {
    parse,
    is(input: unknown): input is T {
      return parse(input).ok;
    },
  };
}

export const unknownSchema = createSchema<unknown>((input) => ok(input));

export const stringSchema = createSchema<string>((input, path) =>
  typeof input === "string" ? ok(input) : fail(`${at(path, "value")} must be a string`),
);

export const nonEmptyStringSchema = createSchema<string>((input, path) => {
  const parsed = stringSchema.parse(input, path);
  if (!parsed.ok) return parsed;
  const value = parsed.value.trim();
  return value.length > 0 ? ok(value) : fail(`${at(path, "value")} must not be empty`);
});

export const numberSchema = createSchema<number>((input, path) =>
  typeof input === "number" && Number.isFinite(input)
    ? ok(input)
    : fail(`${at(path, "value")} must be a finite number`),
);

export const nonNegativeIntegerSchema = createSchema<number>((input, path) => {
  const parsed = numberSchema.parse(input, path);
  if (!parsed.ok) return parsed;
  return Number.isInteger(parsed.value) && parsed.value >= 0
    ? ok(parsed.value)
    : fail(`${at(path, "value")} must be a non-negative integer`);
});

export const booleanSchema = createSchema<boolean>((input, path) =>
  typeof input === "boolean" ? ok(input) : fail(`${at(path, "value")} must be a boolean`),
);

export function literalSchema<const T extends string | number | boolean | null>(
  literal: T,
): Schema<T> {
  return createSchema<T>((input, path) =>
    input === literal
      ? ok(literal)
      : fail(`${at(path, "value")} must equal ${JSON.stringify(literal)}`),
  );
}

export function arraySchema<T>(item: Schema<T>): Schema<T[]> {
  return createSchema<T[]>((input, path) => {
    if (!Array.isArray(input)) {
      return fail(`${at(path, "value")} must be an array`);
    }
    const values: T[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const parsed = item.parse(input[index], `${at(path, "value")}[${index}]`);
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    return ok(values);
  });
}

export function optionalSchema<T>(schema: Schema<T>): Schema<T | undefined> {
  return createSchema<T | undefined>((input, path) =>
    input === undefined ? ok(undefined) : schema.parse(input, path),
  );
}

export function nullableSchema<T>(schema: Schema<T>): Schema<T | null> {
  return createSchema<T | null>((input, path) =>
    input === null ? ok(null) : schema.parse(input, path),
  );
}

export function recordSchema<T>(valueSchema: Schema<T>): Schema<Record<string, T>> {
  return createSchema<Record<string, T>>((input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail(`${at(path, "value")} must be an object`);
    }
    const output: Record<string, T> = {};
    for (const [key, value] of Object.entries(input)) {
      const parsed = valueSchema.parse(value, `${at(path, "value")}.${key}`);
      if (!parsed.ok) return parsed;
      output[key] = parsed.value;
    }
    return ok(output);
  });
}

export function objectSchema<T extends Shape>(
  shape: T,
): Schema<{ readonly [K in keyof T]: T[K] extends Schema<infer V> ? V : never }> {
  type Output = { readonly [K in keyof T]: T[K] extends Schema<infer V> ? V : never };
  return createSchema<Output>((input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return fail(`${at(path, "value")} must be an object`);
    }
    const record = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(shape)) {
      const parsed = schema.parse(record[key], `${at(path, "value")}.${key}`);
      if (!parsed.ok) return parsed;
      if (parsed.value !== undefined) {
        output[key] = parsed.value;
      }
    }
    return ok(output as Output);
  });
}

export function unionSchema<T>(schemas: ReadonlyArray<Schema<T>>): Schema<T> {
  return createSchema<T>((input, path) => {
    const errors: string[] = [];
    for (const schema of schemas) {
      const parsed = schema.parse(input, path);
      if (parsed.ok) return parsed;
      errors.push(parsed.error);
    }
    return fail(`${at(path, "value")} did not match any schema: ${errors.join("; ")}`);
  });
}

export function parseJson<T>(schema: Schema<T>, raw: string): ParseResult<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    return fail(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return schema.parse(decoded);
}

export function parseOrThrow<T>(schema: Schema<T>, input: unknown): T {
  const parsed = schema.parse(input);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}
