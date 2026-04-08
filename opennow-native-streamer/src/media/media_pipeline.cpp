#include "opennow/native/media_pipeline.hpp"

#include <algorithm>
#include <cstring>
#include <sstream>

#include "opennow/native/input_protocol.hpp"

#if defined(OPENNOW_HAS_FFMPEG)
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}
#endif

namespace opennow::native {

#if defined(OPENNOW_HAS_FFMPEG)
namespace {
std::mutex g_ffmpeg_log_mutex;
bool g_suppressed_deprecated_pixel_format_warning = false;

void OpenNowFfmpegLogCallback(void* avcl, int level, const char* fmt, va_list args) {
  if (fmt != nullptr && std::strstr(fmt, "deprecated pixel format used") != nullptr) {
    std::lock_guard<std::mutex> lock(g_ffmpeg_log_mutex);
    if (g_suppressed_deprecated_pixel_format_warning) {
      return;
    }
    g_suppressed_deprecated_pixel_format_warning = true;
  }
  av_log_default_callback(avcl, level, fmt, args);
}

const AVCodec* FindVideoDecoder(const std::string& codec) {
  if (codec == "H265" || codec == "HEVC") {
    return avcodec_find_decoder(AV_CODEC_ID_HEVC);
  }
  if (codec == "AV1") {
    return avcodec_find_decoder(AV_CODEC_ID_AV1);
  }
  return avcodec_find_decoder(AV_CODEC_ID_H264);
}

bool IsPlanarYuv420(enum AVPixelFormat format) {
  return format == AV_PIX_FMT_YUV420P || format == AV_PIX_FMT_YUVJ420P;
}

bool IsNv12Like(enum AVPixelFormat format) {
  return format == AV_PIX_FMT_NV12 || format == AV_PIX_FMT_NV21;
}
}  // namespace
#endif

MediaPipeline::~MediaPipeline() {
  Shutdown();
}

void MediaPipeline::SetLogger(LogFn logger) {
  logger_ = std::move(logger);
}

bool MediaPipeline::Initialize(SDL_Renderer* renderer, std::string& error) {
  renderer_ = renderer;
#if !defined(OPENNOW_HAS_SDL3) || !defined(OPENNOW_HAS_FFMPEG)
  (void)error;
#endif
#if defined(OPENNOW_HAS_SDL3)
  SDL_AudioSpec desired{};
  desired.channels = 2;
  desired.format = SDL_AUDIO_S16;
  desired.freq = 48000;
  audio_stream_ = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &desired, nullptr, nullptr);
  if (!audio_stream_) {
    error = SDL_GetError();
    return false;
  }
  SDL_ResumeAudioStreamDevice(audio_stream_);
  if (!SDL_SetRenderVSync(renderer_, 1)) {
    Log(std::string("Renderer VSync request failed: ") + SDL_GetError());
  } else {
    Log("Renderer VSync enabled for native video presentation");
  }
#endif
#if defined(OPENNOW_HAS_FFMPEG)
  ConfigureFfmpegLogging();
  packet_ = av_packet_alloc();
  video_frame_ = av_frame_alloc();
  audio_frame_ = av_frame_alloc();
  transfer_frame_ = av_frame_alloc();
  if (!packet_ || !video_frame_ || !audio_frame_ || !transfer_frame_) {
    error = "Failed to allocate FFmpeg frame buffers";
    return false;
  }
#endif
  return true;
}

void MediaPipeline::Shutdown() {
#if defined(OPENNOW_HAS_SDL3)
  if (video_texture_) {
    SDL_DestroyTexture(video_texture_);
    video_texture_ = nullptr;
  }
  if (audio_stream_) {
    SDL_DestroyAudioStream(audio_stream_);
    audio_stream_ = nullptr;
  }
#endif
#if defined(OPENNOW_HAS_FFMPEG)
  if (sws_context_) {
    sws_freeContext(sws_context_);
    sws_context_ = nullptr;
  }
  if (swr_context_) {
    swr_free(&swr_context_);
  }
  if (video_decoder_ctx_) {
    avcodec_free_context(&video_decoder_ctx_);
  }
  if (audio_decoder_ctx_) {
    avcodec_free_context(&audio_decoder_ctx_);
  }
  if (hw_device_ctx_) {
    av_buffer_unref(&hw_device_ctx_);
  }
  if (packet_) {
    av_packet_free(&packet_);
  }
  if (video_frame_) {
    av_frame_free(&video_frame_);
  }
  if (audio_frame_) {
    av_frame_free(&audio_frame_);
  }
  if (transfer_frame_) {
    av_frame_free(&transfer_frame_);
  }
#endif
}

void MediaPipeline::ConfigureVideoCodec(const std::string& codec) {
  video_codec_ = codec;
}

void MediaPipeline::ConfigureAudioCodec(const std::string& codec, int payload_type, int clock_rate, int channels) {
  audio_codec_ = codec;
  audio_payload_type_ = payload_type;
  audio_clock_rate_ = clock_rate;
  audio_channels_ = channels;
}

void MediaPipeline::PushVideoFrame(std::vector<std::uint8_t> encoded_frame, std::uint64_t timestamp_us) {
#if defined(OPENNOW_HAS_SDL3) && defined(OPENNOW_HAS_FFMPEG)
  (void)timestamp_us;
  received_video_frames_ += 1;
  DecodeVideoFrame(encoded_frame);
#else
  (void)encoded_frame;
  (void)timestamp_us;
#endif
}

void MediaPipeline::PushAudioFrame(std::vector<std::uint8_t> encoded_frame, std::uint64_t timestamp_us) {
#if defined(OPENNOW_HAS_SDL3) && defined(OPENNOW_HAS_FFMPEG)
  (void)timestamp_us;
  DecodeAudioFrame(encoded_frame);
#else
  (void)encoded_frame;
  (void)timestamp_us;
#endif
}

void MediaPipeline::RenderFrame() {
#if defined(OPENNOW_HAS_SDL3)
  const auto render_started_at_us = TimestampUs();
  std::optional<PendingVideoFrame> pending_frame;
  {
    std::lock_guard<std::mutex> lock(pending_video_mutex_);
    if (pending_video_frame_) {
      pending_frame = std::move(pending_video_frame_);
      pending_video_frame_.reset();
    }
  }
  if (pending_frame) {
    UploadPendingFrame(*pending_frame);
  }
  if (video_texture_ && renderer_) {
    SDL_RenderTexture(renderer_, video_texture_, nullptr, nullptr);
    presented_video_frames_ += 1;
    last_presented_at_us_ = TimestampUs();
  }
  render_time_total_us_ += TimestampUs() - render_started_at_us;
  MaybeLogVideoDiagnostics(last_presented_at_us_ == 0 ? render_started_at_us : last_presented_at_us_);
#endif
}

std::string MediaPipeline::DescribeCapabilities() const {
#if defined(OPENNOW_HAS_FFMPEG) && defined(OPENNOW_HAS_SDL3)
  return video_path_;
#elif defined(OPENNOW_HAS_FFMPEG)
  return "video path: FFmpeg decode available without SDL3 render path";
#else
  return "video path: decode pipeline unavailable";
#endif
}

void MediaPipeline::Log(const std::string& message) const {
  if (logger_) {
    logger_(message);
  }
}

void MediaPipeline::ConfigureFfmpegLogging() {
#if defined(OPENNOW_HAS_FFMPEG)
  av_log_set_callback(OpenNowFfmpegLogCallback);
  Log("FFmpeg logging configured; duplicate deprecated pixel-format warnings will be suppressed");
#endif
}

void MediaPipeline::LogVideoPath(const std::string& path) {
  video_path_ = path;
  if (!logged_decoder_path_) {
    logged_decoder_path_ = true;
    Log(path);
  }
}

void MediaPipeline::MaybeLogVideoDiagnostics(std::uint64_t now_us) {
  constexpr std::uint64_t DIAGNOSTIC_INTERVAL_US = 2000000;
  if (now_us == 0 || now_us < last_diagnostics_log_us_ + DIAGNOSTIC_INTERVAL_US) {
    return;
  }
  std::ostringstream diagnostics;
  diagnostics << "Video diagnostics: received=" << received_video_frames_ << ", staged=" << staged_video_frames_
              << ", dropped_pending=" << dropped_pending_video_frames_ << ", presented=" << presented_video_frames_;
  if (staged_video_frames_ != 0) {
    diagnostics << ", avg_decode_ms=" << (static_cast<double>(decode_time_total_us_) / 1000.0 / static_cast<double>(staged_video_frames_));
  }
  if (presented_video_frames_ != 0) {
    diagnostics << ", avg_upload_ms=" << (static_cast<double>(upload_time_total_us_) / 1000.0 / static_cast<double>(presented_video_frames_));
    diagnostics << ", avg_render_ms=" << (static_cast<double>(render_time_total_us_) / 1000.0 / static_cast<double>(presented_video_frames_));
  }
  diagnostics << ", path=" << video_path_;
  Log(diagnostics.str());
  last_diagnostics_log_us_ = now_us;
}

#if defined(OPENNOW_HAS_SDL3) && defined(OPENNOW_HAS_FFMPEG)
enum AVPixelFormat MediaPipeline::SelectHardwarePixelFormat(AVCodecContext* context, const enum AVPixelFormat* pixel_formats) {
  auto* self = static_cast<MediaPipeline*>(context->opaque);
  for (const enum AVPixelFormat* current = pixel_formats; current != nullptr && *current != AV_PIX_FMT_NONE; ++current) {
    if (*current == self->hw_pixel_format_) {
      return *current;
    }
  }
  self->Log("Hardware decode pixel format negotiation failed; falling back to software surfaces");
  self->using_hardware_decode_ = false;
  return pixel_formats[0];
}

bool MediaPipeline::TryInitializeHardwareDecode(const AVCodec* codec, std::string& error) {
#if defined(__APPLE__)
  if (!codec) {
    return false;
  }
  for (int i = 0;; ++i) {
    const AVCodecHWConfig* config = avcodec_get_hw_config(codec, i);
    if (config == nullptr) {
      break;
    }
    if ((config->methods & AV_CODEC_HW_CONFIG_METHOD_HW_DEVICE_CTX) == 0) {
      continue;
    }
    if (config->device_type != AV_HWDEVICE_TYPE_VIDEOTOOLBOX) {
      continue;
    }
    hw_pixel_format_ = config->pix_fmt;
    if (av_hwdevice_ctx_create(&hw_device_ctx_, AV_HWDEVICE_TYPE_VIDEOTOOLBOX, nullptr, nullptr, 0) < 0) {
      using_hardware_decode_ = false;
      error = "Failed to create VideoToolbox hardware device context";
      return false;
    }
    using_hardware_decode_ = true;
    return true;
  }
#else
  (void)codec;
  (void)error;
#endif
  return false;
}

bool MediaPipeline::EnsureVideoDecoder(std::string& error) {
  if (video_decoder_ctx_) {
    return true;
  }
  const AVCodec* codec = FindVideoDecoder(video_codec_);
  if (!codec) {
    error = "Requested video decoder is unavailable in FFmpeg";
    return false;
  }
  video_decoder_ctx_ = avcodec_alloc_context3(codec);
  if (!video_decoder_ctx_) {
    error = "Failed to allocate video decoder context";
    return false;
  }
  video_decoder_ctx_->opaque = this;
  std::string hardware_error;
  TryInitializeHardwareDecode(codec, hardware_error);
  if (using_hardware_decode_) {
    video_decoder_ctx_->get_format = &MediaPipeline::SelectHardwarePixelFormat;
    video_decoder_ctx_->hw_device_ctx = av_buffer_ref(hw_device_ctx_);
    LogVideoPath("video path: macOS VideoToolbox hardware decode + SDL YUV GPU upload");
  } else {
    if (!hardware_error.empty()) {
      Log(std::string("VideoToolbox initialization unavailable, using fallback path: ") + hardware_error);
    }
    LogVideoPath("video path: software decode + SDL YUV/RGBA upload fallback");
  }
  if (avcodec_open2(video_decoder_ctx_, codec, nullptr) < 0) {
    error = using_hardware_decode_ ? "Failed to open hardware-accelerated video decoder" : "Failed to open video decoder";
    return false;
  }
  return true;
}

bool MediaPipeline::EnsureAudioDecoder(std::string& error) {
  if (audio_decoder_ctx_) {
    return true;
  }
  const AVCodec* codec = avcodec_find_decoder(AV_CODEC_ID_OPUS);
  if (!codec) {
    error = "Opus decoder unavailable";
    return false;
  }
  audio_decoder_ctx_ = avcodec_alloc_context3(codec);
  if (!audio_decoder_ctx_) {
    error = "Failed to allocate audio decoder context";
    return false;
  }
  audio_decoder_ctx_->sample_rate = audio_clock_rate_;
  av_channel_layout_default(&audio_decoder_ctx_->ch_layout, audio_channels_);
  if (avcodec_open2(audio_decoder_ctx_, codec, nullptr) < 0) {
    error = "Failed to open audio decoder";
    return false;
  }
  return true;
}

bool MediaPipeline::EnsureTransferFrame() {
  if (!transfer_frame_) {
    transfer_frame_ = av_frame_alloc();
  }
  return transfer_frame_ != nullptr;
}

void MediaPipeline::DecodeVideoFrame(const std::vector<std::uint8_t>& encoded_frame) {
  std::string error;
  if (!EnsureVideoDecoder(error)) {
    Log(error);
    return;
  }
  av_packet_unref(packet_);
  packet_->data = const_cast<std::uint8_t*>(encoded_frame.data());
  packet_->size = static_cast<int>(encoded_frame.size());
  const auto decode_started_at_us = TimestampUs();
  if (avcodec_send_packet(video_decoder_ctx_, packet_) < 0) {
    return;
  }
  while (avcodec_receive_frame(video_decoder_ctx_, video_frame_) == 0) {
    StageFrame(video_frame_);
  }
  decode_time_total_us_ += TimestampUs() - decode_started_at_us;
}

void MediaPipeline::DecodeAudioFrame(const std::vector<std::uint8_t>& encoded_frame) {
  std::string error;
  if (!EnsureAudioDecoder(error)) {
    Log(error);
    return;
  }
  av_packet_unref(packet_);
  packet_->data = const_cast<std::uint8_t*>(encoded_frame.data());
  packet_->size = static_cast<int>(encoded_frame.size());
  if (avcodec_send_packet(audio_decoder_ctx_, packet_) < 0) {
    return;
  }
  while (avcodec_receive_frame(audio_decoder_ctx_, audio_frame_) == 0) {
    if (!swr_context_) {
      swr_alloc_set_opts2(
          &swr_context_,
          nullptr,
          AV_SAMPLE_FMT_S16,
          48000,
          &audio_frame_->ch_layout,
          static_cast<AVSampleFormat>(audio_frame_->format),
          audio_frame_->sample_rate,
          0,
          nullptr);
      swr_init(swr_context_);
    }
    const int out_samples = swr_get_out_samples(swr_context_, audio_frame_->nb_samples);
    std::vector<std::uint8_t> pcm(static_cast<std::size_t>(out_samples * 2 * 2));
    std::uint8_t* out[] = {pcm.data()};
    const int samples = swr_convert(
        swr_context_,
        out,
        audio_frame_->nb_samples,
        const_cast<const std::uint8_t**>(audio_frame_->extended_data),
        audio_frame_->nb_samples);
    if (samples > 0 && audio_stream_) {
      SDL_PutAudioStreamData(audio_stream_, pcm.data(), samples * 2 * 2);
    }
  }
}

void MediaPipeline::StageFrame(AVFrame* frame) {
  if (!renderer_) {
    return;
  }
  AVFrame* source = frame;
  if (using_hardware_decode_ && frame->format == hw_pixel_format_) {
    if (!EnsureTransferFrame()) {
      Log("Failed to allocate FFmpeg transfer frame for hardware decode output");
      return;
    }
    av_frame_unref(transfer_frame_);
    if (av_hwframe_transfer_data(transfer_frame_, frame, 0) < 0) {
      Log("VideoToolbox frame transfer to CPU-visible surface failed; dropping frame");
      return;
    }
    source = transfer_frame_;
  }
  if (!StageFrameDirect(source)) {
    StageFrameRgba(source);
  }
}

bool MediaPipeline::StageFrameDirect(AVFrame* frame) {
  PendingVideoFrame pending;
  pending.width = frame->width;
  pending.height = frame->height;
  pending.timestamp_us = TimestampUs();
  pending.staged_at_us = pending.timestamp_us;
  const auto format = static_cast<AVPixelFormat>(frame->format);
  if (IsNv12Like(format)) {
    pending.format = PendingVideoFormat::NV12;
    pending.pitch0 = frame->linesize[0];
    pending.pitch1 = frame->linesize[1];
    pending.plane0.resize(static_cast<std::size_t>(pending.pitch0 * pending.height));
    pending.plane1.resize(static_cast<std::size_t>(pending.pitch1 * ((pending.height + 1) / 2)));
    for (int y = 0; y < pending.height; ++y) {
      std::memcpy(pending.plane0.data() + static_cast<std::size_t>(y * pending.pitch0), frame->data[0] + static_cast<std::size_t>(y * frame->linesize[0]), static_cast<std::size_t>(pending.pitch0));
    }
    const int chroma_height = (pending.height + 1) / 2;
    for (int y = 0; y < chroma_height; ++y) {
      std::memcpy(pending.plane1.data() + static_cast<std::size_t>(y * pending.pitch1), frame->data[1] + static_cast<std::size_t>(y * frame->linesize[1]), static_cast<std::size_t>(pending.pitch1));
    }
  } else if (IsPlanarYuv420(format)) {
    pending.format = PendingVideoFormat::IYUV;
    pending.pitch0 = frame->linesize[0];
    pending.pitch1 = frame->linesize[1];
    pending.pitch2 = frame->linesize[2];
    pending.plane0.resize(static_cast<std::size_t>(pending.pitch0 * pending.height));
    pending.plane1.resize(static_cast<std::size_t>(pending.pitch1 * ((pending.height + 1) / 2)));
    pending.plane2.resize(static_cast<std::size_t>(pending.pitch2 * ((pending.height + 1) / 2)));
    for (int y = 0; y < pending.height; ++y) {
      std::memcpy(pending.plane0.data() + static_cast<std::size_t>(y * pending.pitch0), frame->data[0] + static_cast<std::size_t>(y * frame->linesize[0]), static_cast<std::size_t>(pending.pitch0));
    }
    const int chroma_height = (pending.height + 1) / 2;
    for (int y = 0; y < chroma_height; ++y) {
      std::memcpy(pending.plane1.data() + static_cast<std::size_t>(y * pending.pitch1), frame->data[1] + static_cast<std::size_t>(y * frame->linesize[1]), static_cast<std::size_t>(pending.pitch1));
      std::memcpy(pending.plane2.data() + static_cast<std::size_t>(y * pending.pitch2), frame->data[2] + static_cast<std::size_t>(y * frame->linesize[2]), static_cast<std::size_t>(pending.pitch2));
    }
  } else {
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(pending_video_mutex_);
    if (pending_video_frame_) {
      dropped_pending_video_frames_ += 1;
    }
    pending_video_frame_ = std::move(pending);
  }
  staged_video_frames_ += 1;
  if (!logged_stage_thread_) {
    logged_stage_thread_ = true;
    Log("Staged decoded video frames on worker thread using direct YUV planes");
  }
  return true;
}

void MediaPipeline::StageFrameRgba(AVFrame* frame) {
  sws_context_ = sws_getCachedContext(
      sws_context_,
      frame->width,
      frame->height,
      static_cast<AVPixelFormat>(frame->format),
      frame->width,
      frame->height,
      AV_PIX_FMT_RGBA,
      SWS_FAST_BILINEAR,
      nullptr,
      nullptr,
      nullptr);
  if (!sws_context_) {
    Log("Failed to create FFmpeg swscale context for fallback RGBA staging");
    return;
  }
  PendingVideoFrame pending;
  pending.format = PendingVideoFormat::RGBA;
  pending.width = frame->width;
  pending.height = frame->height;
  pending.pitch0 = frame->width * 4;
  pending.timestamp_us = TimestampUs();
  pending.staged_at_us = pending.timestamp_us;
  pending.plane0.resize(static_cast<std::size_t>(pending.pitch0 * pending.height));
  std::uint8_t* dst_data[4] = {pending.plane0.data(), nullptr, nullptr, nullptr};
  int dst_linesize[4] = {pending.pitch0, 0, 0, 0};
  sws_scale(sws_context_, frame->data, frame->linesize, 0, frame->height, dst_data, dst_linesize);
  {
    std::lock_guard<std::mutex> lock(pending_video_mutex_);
    if (pending_video_frame_) {
      dropped_pending_video_frames_ += 1;
    }
    pending_video_frame_ = std::move(pending);
  }
  staged_video_frames_ += 1;
  LogVideoPath(using_hardware_decode_ ? "video path: macOS VideoToolbox decode + RGBA upload fallback" : "video path: software decode + RGBA upload fallback");
  if (!logged_stage_thread_) {
    logged_stage_thread_ = true;
    Log("Staged decoded video frames on worker thread using RGBA fallback");
  }
}

void MediaPipeline::UploadPendingFrame(const PendingVideoFrame& frame) {
  if (!renderer_) {
    return;
  }
  const auto upload_started_at_us = TimestampUs();
  SDL_PixelFormat desired_format = SDL_PIXELFORMAT_RGBA32;
  if (frame.format == PendingVideoFormat::NV12) {
    desired_format = SDL_PIXELFORMAT_NV12;
  } else if (frame.format == PendingVideoFormat::IYUV) {
    desired_format = SDL_PIXELFORMAT_IYUV;
  }
  if (!video_texture_ || texture_width_ != frame.width || texture_height_ != frame.height || texture_format_ != desired_format) {
    if (video_texture_) {
      SDL_DestroyTexture(video_texture_);
      video_texture_ = nullptr;
    }
    texture_width_ = frame.width;
    texture_height_ = frame.height;
    texture_format_ = desired_format;
    video_texture_ = SDL_CreateTexture(renderer_, desired_format, SDL_TEXTUREACCESS_STREAMING, texture_width_, texture_height_);
    if (!video_texture_) {
      std::ostringstream fallback;
      fallback << "Failed to create SDL texture for format " << static_cast<std::uint32_t>(desired_format) << ": " << SDL_GetError();
      Log(fallback.str());
      return;
    }
    Log("Created/updated SDL video texture on render thread");
  }
  bool uploaded = false;
  if (frame.format == PendingVideoFormat::NV12) {
    uploaded = SDL_UpdateNVTexture(video_texture_, nullptr, frame.plane0.data(), frame.pitch0, frame.plane1.data(), frame.pitch1);
  } else if (frame.format == PendingVideoFormat::IYUV) {
    uploaded = SDL_UpdateYUVTexture(video_texture_, nullptr, frame.plane0.data(), frame.pitch0, frame.plane1.data(), frame.pitch1, frame.plane2.data(), frame.pitch2);
  } else {
    uploaded = SDL_UpdateTexture(video_texture_, nullptr, frame.plane0.data(), frame.pitch0);
  }
  if (!uploaded) {
    Log(SDL_GetError());
    return;
  }
  upload_time_total_us_ += TimestampUs() - upload_started_at_us;
  if (!logged_upload_thread_) {
    logged_upload_thread_ = true;
    Log("Uploaded staged video frames on render thread");
  }
}
#endif

}  // namespace opennow::native
