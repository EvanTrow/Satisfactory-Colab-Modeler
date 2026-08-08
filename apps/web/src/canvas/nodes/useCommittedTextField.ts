import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

/**
 * Binds a text input to a "committed" string value (e.g. `node.limit` /
 * `node.clock` / `node.title`), letting the user type freely without every
 * keystroke fighting a Yjs-driven re-render: local text only resyncs from
 * the committed value while the field isn't focused, and `commit` (parse +
 * write) only runs on blur/Enter. `commit` returns whether the write
 * succeeded; a failed commit reverts the field to the last committed
 * display text rather than leaving invalid text sitting in the input.
 *
 * Split out of `RecipeNode.tsx` so `RecipeNodeQuickSettings.tsx` (the
 * right-click quick settings menu) can reuse the identical behavior for the
 * fields it now owns (name, clock).
 */
export function useCommittedTextField(displayText: string, commit: (raw: string) => boolean) {
  const [text, setText] = useState(displayText);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(displayText);
  }, [displayText]);

  return {
    value: text,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (!commit(text)) setText(displayText);
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        setText(displayText);
        event.currentTarget.blur();
      }
    },
  };
}
