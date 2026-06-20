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

export function waitFor(
  conditionFunction: () => boolean,
  failFunction: () => void
): Promise<void> {
  const poll = (resolve: () => void) => {
    if (conditionFunction()) {
      resolve();
    } else {
      failFunction();
      setTimeout(() => poll(resolve), 400);
    }
  };

  return new Promise(poll);
}

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
