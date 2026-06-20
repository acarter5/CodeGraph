import {
  FailReason,
  ParseFail,
  PositionFail,
  MapNode,
  FindDefinitionFail,
  FailNode,
} from "types/index";

// eslint-disable-next-line @typescript-eslint/naming-convention
export function ExcludeNullish<T>(v: T | null | undefined): v is T {
  // eslint-disable-next-line eqeqeq
  return v != null;
}

/*
  Polls `conditionFunction` every `intervalMs` until it returns true, calling
  `failFunction` on each miss. Bails by rejecting once `maxAttempts` misses have
  elapsed (default ~30s at 400ms) so a snapshot that never arrives can't stall
  the whole recursion forever (BUGS.md #9). Pass `maxAttempts: Infinity` to
  restore the old unbounded behavior.
*/
export function waitFor(
  conditionFunction: () => boolean,
  failFunction: () => void,
  { intervalMs = 400, maxAttempts = 75 }: WaitForOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    let misses = 0;
    const poll = () => {
      if (conditionFunction()) {
        resolve();
        return;
      }
      misses += 1;
      if (misses >= maxAttempts) {
        reject(
          new Error(
            `waitFor: condition not met after ${misses} attempts (~${
              misses * intervalMs
            }ms)`
          )
        );
        return;
      }
      failFunction();
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

export type WaitForOptions = {
  intervalMs?: number;
  maxAttempts?: number;
};

export const isParseFailNode = (
  node: FailNode | MapNode
): node is ParseFail => {
  return (node as ParseFail).failReason === FailReason.parseFail;
};

export const isPositionFailNode = (
  node: FailNode | MapNode
): node is PositionFail => {
  return (node as PositionFail).failReason === FailReason.positionFail;
};

export const isFindDefinitionFailNode = (
  node: FailNode | MapNode
): node is FindDefinitionFail => {
  return (
    (node as FindDefinitionFail).failReason === FailReason.findDefinitionFail
  );
};
