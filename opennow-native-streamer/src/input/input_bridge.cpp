#include "opennow/native/input_bridge.hpp"

#include <algorithm>
#include <cmath>

namespace opennow::native {

namespace {
constexpr std::uint64_t HEARTBEAT_INTERVAL_US = 1000000;
constexpr std::uint64_t GAMEPAD_KEEPALIVE_US = 1000000;

#if defined(OPENNOW_HAS_SDL3)
std::string NormalizeKeyName(const char* raw_name) {
  std::string out = raw_name ? raw_name : "";
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) {
    if (c == ' ') {
      return static_cast<char>('_');
    }
    return static_cast<char>(std::toupper(c));
  });
  if (out == "LEFT_SHIFT") return "LSHIFT";
  if (out == "RIGHT_SHIFT") return "RSHIFT";
  if (out == "LEFT_CTRL") return "LCTRL";
  if (out == "RIGHT_CTRL") return "RCTRL";
  if (out == "LEFT_ALT") return "LALT";
  if (out == "RIGHT_ALT") return "RALT";
  if (out == "LEFT_GUI") return "LGUI";
  if (out == "RIGHT_GUI") return "RGUI";
  if (out == "LEFT") return "LEFT";
  if (out == "RIGHT") return "RIGHT";
  if (out == "UP") return "UP";
  if (out == "DOWN") return "DOWN";
  if (out == "RETURN") return "RETURN";
  if (out == "ESCAPE") return "ESCAPE";
  return out;
}

std::uint16_t ButtonFlag(SDL_GamepadButton button) {
  switch (button) {
    case SDL_GAMEPAD_BUTTON_SOUTH: return GAMEPAD_A;
    case SDL_GAMEPAD_BUTTON_EAST: return GAMEPAD_B;
    case SDL_GAMEPAD_BUTTON_WEST: return GAMEPAD_X;
    case SDL_GAMEPAD_BUTTON_NORTH: return GAMEPAD_Y;
    case SDL_GAMEPAD_BUTTON_BACK: return GAMEPAD_BACK;
    case SDL_GAMEPAD_BUTTON_GUIDE: return GAMEPAD_GUIDE;
    case SDL_GAMEPAD_BUTTON_START: return GAMEPAD_START;
    case SDL_GAMEPAD_BUTTON_LEFT_STICK: return GAMEPAD_LS;
    case SDL_GAMEPAD_BUTTON_RIGHT_STICK: return GAMEPAD_RS;
    case SDL_GAMEPAD_BUTTON_LEFT_SHOULDER: return GAMEPAD_LB;
    case SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER: return GAMEPAD_RB;
    case SDL_GAMEPAD_BUTTON_DPAD_UP: return GAMEPAD_DPAD_UP;
    case SDL_GAMEPAD_BUTTON_DPAD_DOWN: return GAMEPAD_DPAD_DOWN;
    case SDL_GAMEPAD_BUTTON_DPAD_LEFT: return GAMEPAD_DPAD_LEFT;
    case SDL_GAMEPAD_BUTTON_DPAD_RIGHT: return GAMEPAD_DPAD_RIGHT;
    default: return 0;
  }
}

template <typename T>
std::int16_t ClampToInt16(T value) {
  const auto as_int = static_cast<int>(value);
  return static_cast<std::int16_t>(std::clamp(as_int, -32768, 32767));
}

#endif
}  // namespace

void InputBridge::SetSendPacket(SendPacket send_packet) {
  send_packet_ = std::move(send_packet);
}

void InputBridge::HandleEvent(const SDL_Event& event) {
#if defined(OPENNOW_HAS_SDL3)
  switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
      HandleMouseMotion(event);
      return;
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
      HandleMouseButton(event, true);
      return;
    case SDL_EVENT_MOUSE_BUTTON_UP:
      HandleMouseButton(event, false);
      return;
    case SDL_EVENT_MOUSE_WHEEL:
      HandleMouseWheel(event);
      return;
    case SDL_EVENT_KEY_DOWN:
      if (!event.key.repeat) {
        HandleKeyboardEvent(event, true);
      }
      return;
    case SDL_EVENT_KEY_UP:
      HandleKeyboardEvent(event, false);
      return;
    case SDL_EVENT_GAMEPAD_ADDED:
      HandleGamepadAdded(event);
      return;
    case SDL_EVENT_GAMEPAD_REMOVED:
      HandleGamepadRemoved(event);
      return;
    case SDL_EVENT_GAMEPAD_AXIS_MOTION:
      HandleGamepadAxis(event);
      return;
    case SDL_EVENT_GAMEPAD_BUTTON_DOWN:
      HandleGamepadButton(event, true);
      return;
    case SDL_EVENT_GAMEPAD_BUTTON_UP:
      HandleGamepadButton(event, false);
      return;
    default:
      return;
  }
#else
  (void)event;
#endif
}

void InputBridge::Tick() {
  if (!input_ready_) {
    return;
  }

  const auto now_us = TimestampUs();
  if (now_us >= last_heartbeat_us_ + HEARTBEAT_INTERVAL_US) {
    Send({encoder_.EncodeHeartbeat(), InputRoute::Reliable});
    last_heartbeat_us_ = now_us;
  }

#if defined(OPENNOW_HAS_SDL3)
  for (const auto& [controller_id, state] : gamepads_) {
    if (state.packet.connected && now_us >= state.last_sent_us + GAMEPAD_KEEPALIVE_US) {
      SendGamepadState(controller_id, true);
    }
  }
#endif
}

void InputBridge::OnInputReady(int protocol_version) {
  input_ready_ = true;
  encoder_.SetProtocolVersion(protocol_version);
  last_heartbeat_us_ = 0;
}

void InputBridge::Reset() {
  input_ready_ = false;
  last_heartbeat_us_ = 0;
  encoder_.ResetGamepadSequenceNumbers();
#if defined(OPENNOW_HAS_SDL3)
  gamepads_.clear();
#endif
  gamepad_bitmap_ = 0;
}

void InputBridge::Send(const InputPacket& packet) {
  if (send_packet_) {
    send_packet_(packet);
  }
}

#if defined(OPENNOW_HAS_SDL3)
void InputBridge::HandleKeyboardEvent(const SDL_Event& event, bool pressed) {
  const auto name = NormalizeKeyName(SDL_GetScancodeName(event.key.scancode));
  const auto mapping = MapKeyName(name);
  if (mapping.vk == 0 || mapping.scancode == 0) {
    return;
  }

  const auto mods = ModifierFlags(
      (event.key.mod & SDL_KMOD_SHIFT) != 0,
      (event.key.mod & SDL_KMOD_CTRL) != 0,
      (event.key.mod & SDL_KMOD_ALT) != 0,
      (event.key.mod & SDL_KMOD_GUI) != 0,
      (event.key.mod & SDL_KMOD_CAPS) != 0,
      (event.key.mod & SDL_KMOD_NUM) != 0);

  KeyboardPacket packet{
      .keycode = mapping.vk,
      .scancode = mapping.scancode,
      .modifiers = mods,
      .timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.key.timestamp)),
  };
  Send({pressed ? encoder_.EncodeKeyDown(packet) : encoder_.EncodeKeyUp(packet), InputRoute::Reliable});
}

void InputBridge::HandleMouseMotion(const SDL_Event& event) {
  if (!input_ready_) {
    return;
  }
  MouseMovePacket packet{
      .dx = ClampToInt16(event.motion.xrel),
      .dy = ClampToInt16(event.motion.yrel),
      .timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.motion.timestamp)),
  };
  Send({encoder_.EncodeMouseMove(packet), InputRoute::Reliable});
}

void InputBridge::HandleMouseButton(const SDL_Event& event, bool pressed) {
  if (!input_ready_) {
    return;
  }
  MouseButtonPacket packet{
      .button = static_cast<std::uint8_t>(event.button.button),
      .timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.button.timestamp)),
  };
  Send({pressed ? encoder_.EncodeMouseButtonDown(packet) : encoder_.EncodeMouseButtonUp(packet), InputRoute::Reliable});
}

void InputBridge::HandleMouseWheel(const SDL_Event& event) {
  if (!input_ready_) {
    return;
  }
  MouseWheelPacket packet{
      .delta = ClampToInt16(-event.wheel.y * 120),
      .timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.wheel.timestamp)),
  };
  Send({encoder_.EncodeMouseWheel(packet), InputRoute::Reliable});
}

void InputBridge::HandleGamepadAdded(const SDL_Event& event) {
  const int controller_id = static_cast<int>(event.gdevice.which);
  auto& state = gamepads_[controller_id];
  state.packet.controller_id = controller_id;
  state.packet.connected = true;
  state.packet.timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.gdevice.timestamp));
  UpdateGamepadBitmap();
  SendGamepadState(controller_id, true);
}

void InputBridge::HandleGamepadRemoved(const SDL_Event& event) {
  const int controller_id = static_cast<int>(event.gdevice.which);
  auto found = gamepads_.find(controller_id);
  if (found == gamepads_.end()) {
    return;
  }
  found->second.packet.connected = false;
  found->second.packet.buttons = 0;
  found->second.packet.left_trigger = 0;
  found->second.packet.right_trigger = 0;
  found->second.packet.left_stick_x = 0;
  found->second.packet.left_stick_y = 0;
  found->second.packet.right_stick_x = 0;
  found->second.packet.right_stick_y = 0;
  found->second.packet.timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.gdevice.timestamp));
  UpdateGamepadBitmap();
  SendGamepadState(controller_id, true);
  gamepads_.erase(found);
}

void InputBridge::HandleGamepadAxis(const SDL_Event& event) {
  const int controller_id = static_cast<int>(event.gaxis.which);
  auto& state = gamepads_[controller_id];
  state.packet.controller_id = controller_id;
  state.packet.connected = true;
  state.packet.timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.gaxis.timestamp));

  const float normalized = std::clamp(static_cast<float>(event.gaxis.value) / 32767.0f, -1.0f, 1.0f);
  switch (event.gaxis.axis) {
    case SDL_GAMEPAD_AXIS_LEFTX:
      state.packet.left_stick_x = NormalizeToInt16(ApplyAxisDeadzone(normalized));
      break;
    case SDL_GAMEPAD_AXIS_LEFTY:
      state.packet.left_stick_y = NormalizeToInt16(-ApplyAxisDeadzone(normalized));
      break;
    case SDL_GAMEPAD_AXIS_RIGHTX:
      state.packet.right_stick_x = NormalizeToInt16(ApplyAxisDeadzone(normalized));
      break;
    case SDL_GAMEPAD_AXIS_RIGHTY:
      state.packet.right_stick_y = NormalizeToInt16(-ApplyAxisDeadzone(normalized));
      break;
    case SDL_GAMEPAD_AXIS_LEFT_TRIGGER:
      state.packet.left_trigger = NormalizeToUint8((normalized + 1.0f) * 0.5f);
      break;
    case SDL_GAMEPAD_AXIS_RIGHT_TRIGGER:
      state.packet.right_trigger = NormalizeToUint8((normalized + 1.0f) * 0.5f);
      break;
    default:
      return;
  }
  UpdateGamepadBitmap();
  SendGamepadState(controller_id, false);
}

void InputBridge::HandleGamepadButton(const SDL_Event& event, bool pressed) {
  const int controller_id = static_cast<int>(event.gbutton.which);
  auto& state = gamepads_[controller_id];
  state.packet.controller_id = controller_id;
  state.packet.connected = true;
  state.packet.timestamp_us = TimestampUs(static_cast<std::uint64_t>(event.gbutton.timestamp));
  const auto flag = ButtonFlag(static_cast<SDL_GamepadButton>(event.gbutton.button));
  if (flag == 0) {
    return;
  }
  if (pressed) {
    state.packet.buttons |= flag;
  } else {
    state.packet.buttons &= static_cast<std::uint16_t>(~flag);
  }
  UpdateGamepadBitmap();
  SendGamepadState(controller_id, false);
}

void InputBridge::SendGamepadState(int controller_id, bool force) {
  if (!input_ready_) {
    return;
  }
  auto found = gamepads_.find(controller_id);
  if (found == gamepads_.end()) {
    return;
  }
  auto& state = found->second;
  const auto now_us = TimestampUs();
  if (!force && state.last_sent_us != 0 && now_us < state.last_sent_us + 2000) {
    return;
  }
  state.packet.timestamp_us = now_us;
  Send({encoder_.EncodeGamepadState(state.packet, gamepad_bitmap_, true), InputRoute::PartiallyReliable});
  state.last_sent_us = now_us;
}

void InputBridge::UpdateGamepadBitmap() {
  gamepad_bitmap_ = 0;
  for (const auto& [controller_id, state] : gamepads_) {
    if (state.packet.connected && controller_id >= 0 && controller_id < 16) {
      gamepad_bitmap_ |= static_cast<std::uint16_t>(1u << controller_id);
    }
  }
}
#endif

}  // namespace opennow::native
