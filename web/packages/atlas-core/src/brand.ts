/** Nominal typing helper. The symbol is declared but never created, so it costs nothing at runtime. */
declare const BRAND: unique symbol;

export type Brand<T, B extends string> = T & { readonly [BRAND]: B };
