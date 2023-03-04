// eslint-disable-next-line @typescript-eslint/naming-convention
export function ExcludeNullish<T>(v: T | null | undefined): v is T {
  // eslint-disable-next-line eqeqeq
  return v != null;
}
