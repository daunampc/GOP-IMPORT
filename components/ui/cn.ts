/**
 * Conditional class joining.
 *
 * Deliberately NOT a `tailwind-merge`-style deduplicator: this design system
 * does not let screens pass colour classes into components, so two classes
 * fighting each other essentially cannot happen. Adding a dependency to solve a
 * problem already prevented at the source is waste.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
