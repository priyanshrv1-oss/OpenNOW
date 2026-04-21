import { GAMEPAD_MAX_CONTROLLERS } from "./inputProtocol";

const MAX_VIBRATION_MS = 5000;
const DEBOUNCE_MS = 16;
const PROBABLE_BINARY_HAPTIC_MESSAGE_TYPES = new Set<number>([
  0x0c,
  0x0d,
  0x12,
  0x13,
  0x20,
  0x21,
  0x30,
  0x31,
]);

interface HapticCommand {
  controllerIndex: number;
  durationMs: number;
  leftMotor: number;
  rightMotor: number;
}

interface ActiveHapticState {
  timeoutId: number | null;
  lastSignature: string;
  lastCommandAtMs: number;
}

type LooseRecord = Record<string, unknown>;

export class HapticsManager {
  private readonly activeByController = new Map<number, ActiveHapticState>();
  private readonly unsupportedControllers = new Set<number>();

  constructor(private readonly onLog: (line: string) => void) {}

  public processMessage(payload: unknown): boolean {
    const command = this.extractCommand(payload);
    if (!command) {
      return false;
    }

    this.applyCommand(command);
    return true;
  }

  public processBinaryMessage(bytes: Uint8Array): boolean {
    const command = this.extractBinaryCommand(bytes);
    if (!command) {
      return false;
    }

    this.applyCommand(command);
    return true;
  }

  public stopController(controllerIndex: number): void {
    if (!this.isValidControllerIndex(controllerIndex)) {
      return;
    }

    this.stopControllerInternal(controllerIndex, "explicit");
  }

  public stopDisconnectedControllers(gamepads: readonly (Gamepad | null)[]): void {
    for (const controllerIndex of this.activeByController.keys()) {
      const gamepad = gamepads[controllerIndex];
      if (!gamepad || !gamepad.connected) {
        this.stopControllerInternal(controllerIndex, "disconnect");
      }
    }
  }

  public stopAll(): void {
    for (const controllerIndex of this.activeByController.keys()) {
      this.stopControllerInternal(controllerIndex, "stop_all");
    }
  }

  public getActiveCount(): number {
    return this.activeByController.size;
  }

  private applyCommand(command: HapticCommand): void {
    const nowMs = performance.now();
    const signature = `${command.durationMs}:${command.leftMotor}:${command.rightMotor}`;
    const active = this.activeByController.get(command.controllerIndex);

    if (
      active &&
      active.lastSignature === signature &&
      (nowMs - active.lastCommandAtMs) < DEBOUNCE_MS
    ) {
      return;
    }

    if (command.durationMs <= 0 || (command.leftMotor <= 0 && command.rightMotor <= 0)) {
      this.stopControllerInternal(command.controllerIndex, "command_stop");
      return;
    }

    const gamepad = this.getGamepad(command.controllerIndex);
    if (!gamepad) {
      this.log(
        `skip haptic, controller ${command.controllerIndex} unavailable`,
      );
      return;
    }

    const actuator = gamepad.vibrationActuator;
    if (!actuator || !this.isDualRumbleActuator(actuator)) {
      if (!this.unsupportedControllers.has(command.controllerIndex)) {
        this.unsupportedControllers.add(command.controllerIndex);
        this.log(
          `controller ${command.controllerIndex} has no dual-rumble actuator`,
        );
      }
      return;
    }

    if (active && active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
    }

    void actuator.playEffect("dual-rumble", {
      startDelay: 0,
      duration: command.durationMs,
      strongMagnitude: command.leftMotor,
      weakMagnitude: command.rightMotor,
    }).catch((error) => {
      this.log(`controller ${command.controllerIndex} playEffect failed: ${String(error)}`);
    });

    const timeoutId = window.setTimeout(() => {
      this.stopControllerInternal(command.controllerIndex, "duration_elapsed");
    }, command.durationMs);

    this.activeByController.set(command.controllerIndex, {
      timeoutId,
      lastCommandAtMs: nowMs,
      lastSignature: signature,
    });

    this.log(
      `controller ${command.controllerIndex} rumble start duration=${command.durationMs}ms left=${command.leftMotor.toFixed(2)} right=${command.rightMotor.toFixed(2)}`,
    );
  }

  private stopControllerInternal(controllerIndex: number, reason: string): void {
    const active = this.activeByController.get(controllerIndex);
    if (active && active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
    }
    this.activeByController.delete(controllerIndex);

    const gamepad = this.getGamepad(controllerIndex);
    const actuator = gamepad?.vibrationActuator;
    if (actuator && this.isDualRumbleActuator(actuator)) {
      void actuator.playEffect("dual-rumble", {
        startDelay: 0,
        duration: 0,
        strongMagnitude: 0,
        weakMagnitude: 0,
      }).catch(() => {});
    }

    this.log(`controller ${controllerIndex} rumble stop (${reason})`);
  }

  private getGamepad(controllerIndex: number): Gamepad | null {
    const gamepads = navigator.getGamepads?.();
    if (!gamepads) {
      return null;
    }

    const gamepad = gamepads[controllerIndex];
    if (!gamepad || !gamepad.connected) {
      return null;
    }

    return gamepad;
  }

  private extractCommand(payload: unknown): HapticCommand | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const root = payload as LooseRecord;
    const candidates = this.collectCandidates(root);
    const hasHapticSignals = candidates.some((candidate) => this.containsHapticFields(candidate));
    if (!hasHapticSignals) {
      return null;
    }

    for (const candidate of candidates) {
      const command = this.parseCommandCandidate(candidate, root);
      if (command) {
        return command;
      }
    }

    return null;
  }

  private extractBinaryCommand(bytes: Uint8Array): HapticCommand | null {
    if (bytes.length < 7) {
      return null;
    }

    const type = bytes[0];
    if (typeof type !== "number" || !PROBABLE_BINARY_HAPTIC_MESSAGE_TYPES.has(type)) {
      return null;
    }

    const command =
      this.parseBinaryU16Layout(bytes, true) ??
      this.parseBinaryU8Layout(bytes, true) ??
      this.parseBinaryU16Layout(bytes, false) ??
      this.parseBinaryU8Layout(bytes, false);

    if (!command) {
      return null;
    }

    this.log(
      `binary haptic message decoded type=0x${type.toString(16)} controller=${command.controllerIndex} duration=${command.durationMs}ms left=${command.leftMotor.toFixed(2)} right=${command.rightMotor.toFixed(2)}`,
    );
    return command;
  }

  private parseBinaryU16Layout(bytes: Uint8Array, hasTypeByte: boolean): HapticCommand | null {
    const start = hasTypeByte ? 1 : 0;
    if (bytes.length < start + 7) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const controllerIndex = view.getUint8(start);
    if (!this.isValidControllerIndex(controllerIndex)) {
      return null;
    }

    const durationMs = Math.min(MAX_VIBRATION_MS, view.getUint16(start + 1, true));
    const leftMotor = this.normalizeMotor(view.getUint16(start + 3, true) / 65535);
    const rightMotor = this.normalizeMotor(view.getUint16(start + 5, true) / 65535);
    if (!this.isPlausibleBinaryHaptic(durationMs, leftMotor, rightMotor)) {
      return null;
    }

    return { controllerIndex, durationMs, leftMotor, rightMotor };
  }

  private parseBinaryU8Layout(bytes: Uint8Array, hasTypeByte: boolean): HapticCommand | null {
    const start = hasTypeByte ? 1 : 0;
    if (bytes.length < start + 5) {
      return null;
    }

    const controllerIndex = bytes[start];
    if (!this.isValidControllerIndex(controllerIndex)) {
      return null;
    }

    const durationMs = Math.min(MAX_VIBRATION_MS, (bytes[start + 1]! | (bytes[start + 2]! << 8)));
    const leftMotor = this.normalizeMotor((bytes[start + 3] ?? 0) / 255);
    const rightMotor = this.normalizeMotor((bytes[start + 4] ?? 0) / 255);
    if (!this.isPlausibleBinaryHaptic(durationMs, leftMotor, rightMotor)) {
      return null;
    }

    return { controllerIndex, durationMs, leftMotor, rightMotor };
  }

  private isPlausibleBinaryHaptic(durationMs: number, leftMotor: number, rightMotor: number): boolean {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_VIBRATION_MS) {
      return false;
    }
    if (!Number.isFinite(leftMotor) || !Number.isFinite(rightMotor)) {
      return false;
    }
    return (durationMs > 0 && (leftMotor > 0 || rightMotor > 0)) || (durationMs === 0 && leftMotor === 0 && rightMotor === 0);
  }

  private collectCandidates(root: LooseRecord): LooseRecord[] {
    const candidates: LooseRecord[] = [];
    const queue: LooseRecord[] = [root];
    const visited = new Set<LooseRecord>();
    const nestedKeys = ["haptic", "rumble", "vibration", "payload", "data", "params", "message", "command", "nvExtendedCommandMessage"];

    while (queue.length > 0 && candidates.length < 32) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      candidates.push(current);

      for (const key of nestedKeys) {
        const value = current[key];
        if (value && typeof value === "object") {
          queue.push(value as LooseRecord);
        }
      }

      const customMessage = current.customMessage;
      if (typeof customMessage === "string" && customMessage.trim().length > 0) {
        const parsedCustom = this.parseNestedJsonString(customMessage);
        if (parsedCustom) {
          this.log(`parsed customMessage: ${JSON.stringify(parsedCustom)}`);
          queue.push(parsedCustom);
        }
      }
    }

    return candidates;
  }

  private containsHapticFields(source: unknown): boolean {
    if (!source || typeof source !== "object") {
      return false;
    }

    const record = source as LooseRecord;
    const hapticKeys = [
      "durationMs",
      "duration",
      "haptic",
      "rumble",
      "vibration",
      "leftMotor",
      "rightMotor",
      "strongMagnitude",
      "weakMagnitude",
      "stop",
      "action",
      "type",
      "customMessage",
    ];
    for (const key of hapticKeys) {
      if (key in record) {
        return true;
      }
    }

    if (this.hasHapticKeywordSignal(record)) {
      return true;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === "object" && this.containsHapticFields(value)) {
        return true;
      }
    }

    return false;
  }

  private parseCommandCandidate(candidate: LooseRecord, root: LooseRecord): HapticCommand | null {
    const controllerIndexRaw = this.readNumber(candidate, ["controllerIndex", "controllerId", "gamepadIndex", "index", "pad"])
      ?? this.readNumber(root, ["controllerIndex", "controllerId", "gamepadIndex", "index", "pad"]);
    if (controllerIndexRaw === null || !Number.isFinite(controllerIndexRaw)) {
      return null;
    }

    const controllerIndex = Math.floor(controllerIndexRaw);
    if (!this.isValidControllerIndex(controllerIndex)) {
      return null;
    }

    const stopRequested = this.readStopFlag(candidate) || this.readStopFlag(root);
    const durationRaw = this.readNumber(candidate, ["durationMs", "duration", "durationMilliseconds", "ms"])
      ?? this.readNumber(root, ["durationMs", "duration", "durationMilliseconds", "ms"])
      ?? 0;
    const leftRaw = this.readNumber(candidate, ["leftMotor", "strongMagnitude", "lowFrequency", "left", "largeMotor"])
      ?? this.readNumber(root, ["leftMotor", "strongMagnitude", "lowFrequency", "left", "largeMotor"])
      ?? 0;
    const rightRaw = this.readNumber(candidate, ["rightMotor", "weakMagnitude", "highFrequency", "right", "smallMotor"])
      ?? this.readNumber(root, ["rightMotor", "weakMagnitude", "highFrequency", "right", "smallMotor"])
      ?? 0;

    const durationMs = stopRequested ? 0 : Math.max(0, Math.min(MAX_VIBRATION_MS, Math.floor(durationRaw)));
    const leftMotor = stopRequested ? 0 : this.normalizeMotor(leftRaw);
    const rightMotor = stopRequested ? 0 : this.normalizeMotor(rightRaw);

    return {
      controllerIndex,
      durationMs,
      leftMotor,
      rightMotor,
    };
  }

  private readStopFlag(source: LooseRecord): boolean {
    const flag = source.stop;
    if (typeof flag === "boolean") {
      return flag;
    }

    const action = source.action;
    if (typeof action === "string" && action.toLowerCase() === "stop") {
      return true;
    }

    const type = source.type;
    if (typeof type === "string" && type.toLowerCase() === "stop") {
      return true;
    }

    return false;
  }

  private readNumber(source: LooseRecord, keys: string[]): number | null {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  private normalizeMotor(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value > 1 && value <= 100) {
      return Math.max(0, Math.min(1, value / 100));
    }
    return Math.max(0, Math.min(1, value));
  }

  private isValidControllerIndex(controllerIndex: number): boolean {
    return controllerIndex >= 0 && controllerIndex < GAMEPAD_MAX_CONTROLLERS;
  }

  private hasHapticKeywordSignal(record: LooseRecord): boolean {
    const signalKeys = ["messageType", "commandType", "eventType", "name", "kind", "type", "action"];
    for (const key of signalKeys) {
      const value = record[key];
      if (typeof value !== "string") {
        continue;
      }
      const normalized = value.toLowerCase();
      if (normalized.includes("haptic") || normalized.includes("rumble") || normalized.includes("vibration")) {
        return true;
      }
    }
    return false;
  }

  private parseNestedJsonString(raw: string): LooseRecord | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const tryParse = (input: string): unknown => {
      try {
        return JSON.parse(input);
      } catch {
        return null;
      }
    };

    const parsed = tryParse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as LooseRecord;
    }
    if (typeof parsed === "string") {
      const parsedTwice = tryParse(parsed);
      if (parsedTwice && typeof parsedTwice === "object") {
        return parsedTwice as LooseRecord;
      }
    }
    return null;
  }

  private isDualRumbleActuator(actuator: GamepadHapticActuator): boolean {
    const typedActuator = actuator as GamepadHapticActuator & { type?: string };
    if (typedActuator.type === undefined) {
      return true;
    }
    return typedActuator.type === "dual-rumble";
  }

  private log(message: string): void {
    this.onLog(`[Haptics] ${message}`);
  }
}
