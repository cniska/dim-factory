# TypeScript

How TypeScript is written in this project, where its own rules say nothing else. The builder writes to it; review raises a breach in the diff as a finding.

## Types

- **`null` is the empty value.** A deliberately empty field, return or wire value is `T | null`, never `x?: T` or `T | undefined`: `undefined` also means unset, misspelled or never assigned. `undefined` stays where the language produces it, an optional parameter or an index read, and is checked there, not passed on. `tsc --strict` accepts `x !== undefined` on a `string | null`, and that branch runs for every value, empty or not.
- **Schema first.** A string union or a shared type is a zod schema, and the type is inferred from it. `z.strictObject` for shapes the project owns, `z.looseObject` for shapes it does not.
- **Variants** are a union discriminated on one field, never a flag beside optional fields.
- **`unknown`, never `any`**, for external data. `JSON.parse` and `response.json()` return `any`, which satisfies every type it is assigned to; take the result as `unknown` and parse it.
- **No `as` to silence the compiler.** Narrow with a check, assert with an `invariant(condition, message)` helper, or fix the type. `as const` and `satisfies` check rather than claim.
- **A `switch` over a union** ends in `default: return unreachable(value)` with `value: never`. Use the project's `invariant` and `unreachable` helpers, or add them, before reaching for `!` or `as`.
- **`readonly`** on every field and array that crosses a module boundary.

## Errors and async

- Catch as `unknown` and narrow; never assume `err.message` exists. Rethrow with the original attached as `cause`.
- A promise is awaited, returned, or detached with a handler.
- `@ts-expect-error` over `@ts-ignore`, so the suppression fails once the error is gone.

## React

- **A surface has one data owner.** A server prop copied into `useState` is a second owner that goes stale; a draft being typed is client state and stays local.
- **An effect is the last resort.** What `useEffect` gets reached for is usually derived state, a handler on the event itself, or a subscription (`useSyncExternalStore`).

## Drift

A model's memory lags its tools; read the installed version's types before writing an API from memory.

- zod 4 moved string formats to top-level schemas (`z.email()`, `z.uuid()`, `z.url()`), replaced `.passthrough()` and `.merge()` with `z.looseObject()` and `.extend(other.shape)`, folded `z.nativeEnum` into `z.enum`, and renamed the `message` parameter to `error`.
- TypeScript 7 has `strict` on by default and removed `baseUrl`, `outFile`, `downlevelIteration`, `moduleResolution: "node10"` and `target: "es5"`; a config naming one fails to load.
