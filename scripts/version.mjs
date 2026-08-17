/**
 * Wzór wersji aplikacji z liczby commitów. Jedyne miejsce, w którym żyje ten
 * wzór - używają go stamp-version.mjs oraz testy.
 *
 * Wersja: 0.<n div 100>.<n mod 100>, małymi literami, bez prefiksu 'v'.
 * Przykłady: 112 → 0.1.12, 113 → 0.1.13, 199 → 0.1.99, 200 → 0.2.0, 1204 → 0.12.4.
 */
export function versionFromCommitCount(n) {
  const major = Math.floor(n / 100);
  const minor = n % 100;
  return `0.${major}.${minor}`;
}
