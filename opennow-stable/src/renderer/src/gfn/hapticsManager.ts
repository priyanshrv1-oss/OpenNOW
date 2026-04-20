import { GAMEPAD_MAX_CONTROLLERS } from "./inputProtocol";

const MAX_VIBRATION_MS = 5000;
const DEBOUNCE_MS = 16;

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
    if (!this.containsHapticFields(root)) {
      return null;
    }

    const candidates = this.collectCandidates(root);
    for (const candidate of candidates) {
      const command = this.parseCommandCandidate(candidate, root);
      if (command) {
        return command;
      }
    }

    return null;
  }

  private collectCandidates(root: LooseRecord): LooseRecord[] {
    const candidates: LooseRecord[] = [root];
    const nestedKeys = ["haptic", "rumble", "vibration", "payload", "data", "params", "message", "command"];
    for (const key of nestedKeys) {
      const value = root[key];
      if (value && typeof value === "object") {
        candidates.push(value as LooseRecord);
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
    ];
    for (const key of hapticKeys) {
      if (key in record) {
        return true;
      }
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
