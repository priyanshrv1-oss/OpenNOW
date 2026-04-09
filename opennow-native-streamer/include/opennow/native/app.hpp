#pragma once

#include <memory>
#include <string>

#include "opennow/native/input_bridge.hpp"
#include "opennow/native/ipc_client.hpp"
#include "opennow/native/media_pipeline.hpp"
#include "opennow/native/webrtc_session.hpp"

#if defined(OPENNOW_HAS_SDL3)
#include <SDL3/SDL.h>
#else
struct SDL_Window;
struct SDL_Renderer;
#endif

namespace opennow::native {

class Application {
 public:
  Application(std::string ipc_host, int ipc_port, std::string session_id);
  ~Application();

  bool Initialize(std::string& error);
  int Run();

 private:
  enum class MainThreadAction {
    ActivateStream,
    DeactivateStream,
    Disconnect,
  };

  void HandleIncomingJson(const std::string& json);
  void QueueMainThreadAction(MainThreadAction action);
  void ProcessMainThreadAction(MainThreadAction action);
  void EmitState(const std::string& state, const std::string& message, const std::string& detail = "");
  void EmitLog(const std::string& message);
  void EmitInput(InputPacket packet);
  void SetStreamingActive(bool active);
  void SetFullscreen(bool enabled, const std::string& reason);
  void SetMouseCapture(bool enabled, const std::string& reason);
  void RenderDebugOverlay();

  std::string ipc_host_;
  int ipc_port_;
  std::string session_id_;
  SDL_Window* window_{nullptr};
  SDL_Renderer* renderer_{nullptr};
  std::uint32_t main_thread_event_type_{0};
  bool running_{false};
  bool stream_active_{false};
  bool fullscreen_enabled_{false};
  bool mouse_capture_enabled_{false};
  IpcClient ipc_client_;
  InputBridge input_bridge_;
  MediaPipeline media_pipeline_;
  WebRtcSession webrtc_session_;
};

}  // namespace opennow::native
