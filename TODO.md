# TODO — design tasks

Forward-looking refactors that are bigger than a bug fix. Reference an entry
from code with its slug, e.g. `// TODO(some-slug): …` so the call sites that
motivate the change are easy to find. Delete an entry once it ships.

---

_No open entries._

<!--
Shipped:
- position-based-node-lookup — the Parser now looks the function node up by
  position in the full-file AST (`getPositionOfLineAndCharacter` + widest
  function-like node within the definition range, with an ancestor-walk
  fallback for name-only ranges). Deleted the isolated-snippet reparse, the
  `__CodeGraphWrapper__` member fallback, and `Scanner._findPositionedFunctionNode`
  / `looksLike` structural match. This also removed the `positionFail` failure
  mode: large/complex functions no longer fail a structural re-match and lose
  their whole subtree.
-->
