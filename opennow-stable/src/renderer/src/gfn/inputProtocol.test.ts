import test from "node:test";
import assert from "node:assert/strict";

import { codeMap, mapKeyboardEvent, mapTextCharToKeySpec } from "./inputProtocol";

function keyboardEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, "code" | "key">): KeyboardEvent {
  return {
    code: init.code,
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    keyCode: init.keyCode ?? 0,
    getModifierState: init.getModifierState ?? (() => false),
  } as KeyboardEvent;
}

test("maps representative physical keys to Windows set-1 scancodes", () => {
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "KeyA", key: "a" })), codeMap.KeyA);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "KeyN", key: "n" })), codeMap.KeyN);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "KeyT", key: "t" })), codeMap.KeyT);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "KeyZ", key: "z" })), codeMap.KeyZ);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "Comma", key: "," })), codeMap.Comma);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "Slash", key: "/" })), codeMap.Slash);
});

test("maps escape and left/right modifiers with correct scancodes", () => {
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "Escape", key: "Escape" })), codeMap.Escape);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "ShiftLeft", key: "Shift" })), codeMap.ShiftLeft);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "ShiftRight", key: "Shift" })), codeMap.ShiftRight);
});

test("maps non-US and numpad physical keys", () => {
  assert.deepEqual(
    mapKeyboardEvent(keyboardEvent({ code: "IntlBackslash", key: "<" })),
    codeMap.IntlBackslash,
  );
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "NumLock", key: "NumLock" })), codeMap.NumLock);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "Numpad0", key: "0" })), codeMap.Numpad0);
  assert.deepEqual(mapKeyboardEvent(keyboardEvent({ code: "NumpadEnter", key: "Enter" })), codeMap.NumpadEnter);
});

test("prefers physical code over layout-dependent key value", () => {
  const event = keyboardEvent({ code: "KeyZ", key: "y" });
  assert.deepEqual(mapKeyboardEvent(event), codeMap.KeyZ);
});

test("falls back to key-based escape detection when code is unavailable", () => {
  const event = keyboardEvent({ code: "", key: "Escape", keyCode: 27 });
  assert.deepEqual(mapKeyboardEvent(event), codeMap.Escape);
});

test("uses corrected scancodes for synthetic text injection", () => {
  assert.deepEqual(mapTextCharToKeySpec("a"), { ...codeMap.KeyA });
  assert.deepEqual(mapTextCharToKeySpec("N"), { ...codeMap.KeyN, shift: true });
  assert.deepEqual(mapTextCharToKeySpec("<"), { ...codeMap.Comma, shift: true });
  assert.deepEqual(mapTextCharToKeySpec("/"), { ...codeMap.Slash });
  assert.deepEqual(mapTextCharToKeySpec("?"), { ...codeMap.Slash, shift: true });
});
