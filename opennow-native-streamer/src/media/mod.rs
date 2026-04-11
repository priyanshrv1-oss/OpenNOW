use std::{
    collections::HashMap,
    env,
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use gilrs::{Axis, Button, EventType, Gamepad, Gilrs};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::{AppSink, AppSinkCallbacks};
use gstreamer_video::{VideoFrameRef, VideoInfo};
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use gtk4::{gdk, glib, prelude::*};
use gtk4::glib::ControlFlow;

use crate::{
    input::protocol::{InputEncoder, InputPacketEnvelope},
    ipc::{EventMessage, IceCandidate, NativeStats, NativeStreamerState},
    session::types::NativeSessionConfig,
    webrtc::sdp::{
        build_manual_ice_candidates, build_nvst_sdp, extract_ice_credentials, extract_ice_ufrag_from_offer,
        fix_server_ip, munge_answer_sdp, normalize_sdp_line_endings, parse_partial_reliable_threshold_ms, prefer_codec, CodecPreferenceOptions,
        NvstParams,
    },
};

#[derive(Clone)]
pub struct MediaRuntime {
    tx: Sender<MediaCommand>,
}

pub enum MediaCommand {
    Bootstrap { title: String },
    StartSession { config: NativeSessionConfig },
    ApplyOffer { sdp: String },
    AddRemoteIce { candidate: IceCandidate },
    SendInput { payload: InputPacketEnvelope },
    Stop { reason: Option<String> },
}

#[derive(Clone)]
struct InputForwarder {
    tx: Sender<MediaCommand>,
}

impl InputForwarder {
    fn send(&self, payload: InputPacketEnvelope) {
        let _ = self.tx.send(MediaCommand::SendInput { payload });
    }
}

struct VideoFrameUpdate {
    width: i32,
    height: i32,
    stride: usize,
    data: Vec<u8>,
}

struct RuntimeState {
    window: gtk4::Window,
    picture: gtk4::Picture,
    config: Option<NativeSessionConfig>,
    pipeline: Option<gst::Pipeline>,
    webrtcbin: Option<gst::Element>,
    reliable_channel: Option<gst_webrtc::WebRTCDataChannel>,
    mouse_channel: Option<gst_webrtc::WebRTCDataChannel>,
    stats: Arc<Mutex<NativeStats>>,
    events: Sender<EventMessage>,
    frame_tx: Sender<VideoFrameUpdate>,
    frame_rx: Receiver<VideoFrameUpdate>,
    bus_watch: Option<gst::bus::BusWatchGuard>,
    input_encoder: Arc<Mutex<InputEncoder>>,
    partial_reliable_threshold_ms: u32,
    last_heartbeat: Instant,
    gilrs: Option<Gilrs>,
    last_gamepad_snapshot: HashMap<u32, Vec<u8>>,
    streaming_announced: bool,
}

impl MediaRuntime {
    pub fn new(events: Sender<EventMessage>) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<MediaCommand>();
        let thread_tx = tx.clone();
        std::thread::Builder::new()
            .name("opennow-native-streamer-ui".into())
            .spawn(move || run_ui_thread(rx, thread_tx, events))
            .context("failed to spawn native UI thread")?;
        Ok(Self { tx })
    }

    pub fn bootstrap(&self, title: String) -> Result<()> {
        self.tx.send(MediaCommand::Bootstrap { title })?;
        Ok(())
    }

    pub fn start_session(&self, config: NativeSessionConfig) -> Result<()> {
        self.tx.send(MediaCommand::StartSession { config })?;
        Ok(())
    }

    pub fn apply_offer(&self, sdp: String) -> Result<()> {
        self.tx.send(MediaCommand::ApplyOffer { sdp })?;
        Ok(())
    }

    pub fn add_remote_ice(&self, candidate: IceCandidate) -> Result<()> {
        self.tx.send(MediaCommand::AddRemoteIce { candidate })?;
        Ok(())
    }

    pub fn send_input(&self, payload: InputPacketEnvelope) -> Result<()> {
        self.tx.send(MediaCommand::SendInput { payload })?;
        Ok(())
    }

    pub fn stop(&self, reason: Option<String>) -> Result<()> {
        self.tx.send(MediaCommand::Stop { reason })?;
        Ok(())
    }
}

fn run_ui_thread(rx: Receiver<MediaCommand>, tx: Sender<MediaCommand>, events: Sender<EventMessage>) {
    if let Err(error) = gst::init() {
        let _ = events.send(EventMessage::Error {
            code: "gst_init".into(),
            message: error.to_string(),
            recoverable: false,
        });
        return;
    }
    if let Err(error) = gtk4::init() {
        let _ = events.send(EventMessage::Error {
            code: "gtk_init".into(),
            message: error.to_string(),
            recoverable: false,
        });
        return;
    }

    let picture = gtk4::Picture::new();
    picture.set_can_shrink(true);
    picture.set_hexpand(true);
    picture.set_vexpand(true);
    picture.set_focusable(true);

    let window = gtk4::Window::builder()
        .title("OpenNOW Native Streamer")
        .default_width(1280)
        .default_height(720)
        .build();
    window.set_child(Some(&picture));

    let (frame_tx, frame_rx) = mpsc::channel();
    let state = Arc::new(Mutex::new(RuntimeState {
        window: window.clone(),
        picture: picture.clone(),
        config: None,
        pipeline: None,
        webrtcbin: None,
        reliable_channel: None,
        mouse_channel: None,
        stats: Arc::new(Mutex::new(NativeStats::default())),
        events: events.clone(),
        frame_tx,
        frame_rx,
        bus_watch: None,
        input_encoder: Arc::new(Mutex::new(InputEncoder::default())),
        partial_reliable_threshold_ms: 250,
        last_heartbeat: Instant::now(),
        gilrs: Gilrs::new().ok(),
        last_gamepad_snapshot: HashMap::new(),
        streaming_announced: false,
    }));

    install_input_controllers(&window, &picture, InputForwarder { tx });

    let main_loop = glib::MainLoop::new(None, false);
    let main_loop_for_close = main_loop.clone();
    window.connect_close_request(move |_| {
        main_loop_for_close.quit();
        gtk4::glib::Propagation::Proceed
    });

    {
        let state = state.clone();
        glib::timeout_add_local(Duration::from_millis(8), move || {
            while let Ok(command) = rx.try_recv() {
                let mut state = state.lock().expect("runtime state poisoned");
                if let Err(error) = state.handle_command(command) {
                    let _ = state.events.send(EventMessage::Error {
                        code: "runtime_command".into(),
                        message: error.to_string(),
                        recoverable: false,
                    });
                }
            }
            ControlFlow::Continue
        });
    }

    {
        let state = state.clone();
        glib::timeout_add_local(Duration::from_millis(16), move || {
            let mut state = state.lock().expect("runtime state poisoned");
            state.drain_video_frames();
            state.poll_gamepads();
            state.send_heartbeat_if_ready();
            ControlFlow::Continue
        });
    }

    window.present();
    let _ = events.send(EventMessage::Ready);
    let _ = events.send(EventMessage::State {
        state: NativeStreamerState::Idle,
        detail: Some("native window ready".into()),
    });
    main_loop.run();
}

impl RuntimeState {
    fn handle_command(&mut self, command: MediaCommand) -> Result<()> {
        match command {
            MediaCommand::Bootstrap { title } => {
                self.window.set_title(Some(&title));
            }
            MediaCommand::StartSession { config } => {
                self.window.set_title(Some(&config.window_title));
                self.config = Some(config);
                self.streaming_announced = false;
                let _ = self.events.send(EventMessage::Log {
                    level: "info".into(),
                    message: "received start_session command".into(),
                });
                self.ensure_pipeline()?;
                let _ = self.events.send(EventMessage::State {
                    state: NativeStreamerState::AwaitingOffer,
                    detail: Some("session configuration received".into()),
                });
            }
            MediaCommand::ApplyOffer { sdp } => {
                let _ = self.events.send(EventMessage::Log {
                    level: "info".into(),
                    message: "received signaling_offer command".into(),
                });
                self.apply_offer(&sdp)?;
            }
            MediaCommand::AddRemoteIce { candidate } => {
                if let Some(webrtcbin) = &self.webrtcbin {
                    let index = candidate
                        .sdp_mline_index
                        .or_else(|| candidate.sdp_mid.as_deref().and_then(|value| value.parse::<u32>().ok()))
                        .unwrap_or(0);
                    let _ = self.events.send(EventMessage::Log {
                        level: "debug".into(),
                        message: format!("remote ICE mline={index} candidate={}", candidate.candidate),
                    });
                    webrtcbin.emit_by_name::<()>("add-ice-candidate", &[&index, &candidate.candidate]);
                }
            }
            MediaCommand::SendInput { payload } => self.send_input_packet(payload),
            MediaCommand::Stop { reason } => {
                self.stop_pipeline();
                self.events.send(EventMessage::Stopped { reason })?;
            }
        }
        Ok(())
    }

    fn ensure_pipeline(&mut self) -> Result<()> {
        if self.pipeline.is_some() {
            return Ok(());
        }

        let pipeline = gst::Pipeline::new();
        let webrtcbin = gst::ElementFactory::make("webrtcbin")
            .name("webrtcbin")
            .build()
            .context("failed to build webrtcbin")?;
        webrtcbin.set_property_from_str("bundle-policy", "max-bundle");
        webrtcbin.set_property("latency", 0u32);
        pipeline.add(&webrtcbin)?;

        let events = self.events.clone();
        webrtcbin.connect("on-ice-candidate", false, move |values| {
            let mline = values[1].get::<u32>().unwrap_or(0);
            let candidate = values[2].get::<String>().unwrap_or_default();
            let _ = events.send(EventMessage::LocalIce {
                candidate: IceCandidate {
                    candidate,
                    sdp_mid: Some(mline.to_string()),
                    sdp_mline_index: Some(mline),
                    username_fragment: None,
                },
            });
            None
        });

        {
            let events = self.events.clone();
            webrtcbin.connect_notify(Some("connection-state"), move |element, _| {
                let state = element.property_value("connection-state");
                let _ = events.send(EventMessage::Log {
                    level: "info".into(),
                    message: format!("webrtc connection-state={state:?}"),
                });
            });
        }

        {
            let events = self.events.clone();
            webrtcbin.connect_notify(Some("ice-connection-state"), move |element, _| {
                let state = element.property_value("ice-connection-state");
                let _ = events.send(EventMessage::Log {
                    level: "info".into(),
                    message: format!("webrtc ice-connection-state={state:?}"),
                });
            });
        }

        let frame_tx = self.frame_tx.clone();
        let events = self.events.clone();
        let stats_for_pad_added = self.stats.clone();
        let pipeline_weak = pipeline.downgrade();
        let events_for_pad_added = events.clone();
        webrtcbin.connect_pad_added(move |_element, pad| {
            let Some(pipeline) = pipeline_weak.upgrade() else {
                return;
            };
            if pad.direction() != gst::PadDirection::Src {
                return;
            }
            let decodebin = match gst::ElementFactory::make("decodebin").build() {
                Ok(value) => value,
                Err(error) => {
                    let _ = events_for_pad_added.send(EventMessage::Error {
                        code: "decodebin_create".into(),
                        message: error.to_string(),
                        recoverable: false,
                    });
                    return;
                }
            };
            let pipeline_weak = pipeline.downgrade();
            let frame_tx = frame_tx.clone();
            let events_for_decode = events.clone();
            let stats = stats_for_pad_added.clone();
            decodebin.connect_pad_added(move |_decodebin, src_pad| {
                let Some(pipeline) = pipeline_weak.upgrade() else {
                    return;
                };
                let Some(caps) = src_pad.current_caps() else {
                    return;
                };
                let Some(structure) = caps.structure(0) else {
                    return;
                };
                let media = structure.name();
                let result = if media.starts_with("video/") {
                    attach_video_branch(&pipeline, src_pad, &frame_tx, &stats, &events_for_decode)
                } else if media.starts_with("audio/") {
                    attach_audio_branch(&pipeline, src_pad, &stats, &events_for_decode)
                } else {
                    Ok(())
                };
                if let Err(error) = result {
                    let _ = events_for_decode.send(EventMessage::Error {
                        code: "stream_branch".into(),
                        message: error.to_string(),
                        recoverable: false,
                    });
                }
            });
            if let Err(error) = pipeline.add(&decodebin) {
                let _ = events.send(EventMessage::Error {
                    code: "decodebin_add".into(),
                    message: error.to_string(),
                    recoverable: false,
                });
                return;
            }
            if let Err(error) = decodebin.sync_state_with_parent() {
                let _ = events.send(EventMessage::Error {
                    code: "decodebin_sync".into(),
                    message: error.to_string(),
                    recoverable: false,
                });
                return;
            }
            if let Some(sink_pad) = decodebin.static_pad("sink") {
                let _ = pad.link(&sink_pad);
            }
        });

        if let Some(bus) = pipeline.bus() {
            let events = self.events.clone();
            let watch = bus.add_watch_local(move |_bus, message| {
                use gst::MessageView;
                match message.view() {
                    MessageView::Error(error) => {
                        let _ = events.send(EventMessage::Error {
                            code: "gst_bus".into(),
                            message: format!("{} ({})", error.error(), error.debug().unwrap_or_default()),
                            recoverable: false,
                        });
                    }
                    MessageView::Warning(warning) => {
                        let _ = events.send(EventMessage::Log {
                            level: "warn".into(),
                            message: format!("{} ({})", warning.error(), warning.debug().unwrap_or_default()),
                        });
                    }
                    _ => {}
                }
                ControlFlow::Continue
            })?;
            self.bus_watch = Some(watch);
        }

        pipeline.set_state(gst::State::Playing)?;
        self.reliable_channel = Some(create_data_channel(&webrtcbin, "input_channel_v1", true, None)?);
        self.mouse_channel = Some(create_data_channel(
            &webrtcbin,
            "input_channel_partially_reliable",
            false,
            Some(self.partial_reliable_threshold_ms as i32),
        )?);

        if let Some(channel) = &self.reliable_channel {
            let encoder = self.input_encoder.clone();
            let events = self.events.clone();
            channel.connect_notify(Some("ready-state"), move |channel, _| {
                let _ = events.send(EventMessage::Log {
                    level: "info".into(),
                    message: format!(
                        "reliable data channel ready-state={:?}",
                        channel.property_value("ready-state")
                    ),
                });
            });
            let events = self.events.clone();
            let stats = self.stats.clone();
            channel.connect_on_message_data(move |_channel, data| {
                if let Some(bytes) = data {
                    handle_input_handshake(bytes.as_ref(), &encoder, &events, &stats);
                }
            });
        }
        if let Some(channel) = &self.mouse_channel {
            let events = self.events.clone();
            channel.connect_notify(Some("ready-state"), move |channel, _| {
                let _ = events.send(EventMessage::Log {
                    level: "info".into(),
                    message: format!(
                        "partial data channel ready-state={:?}",
                        channel.property_value("ready-state")
                    ),
                });
            });
        }

        let events = self.events.clone();
        webrtcbin.connect("on-data-channel", false, move |values| {
            if let Ok(channel) = values[1].get::<gst_webrtc::WebRTCDataChannel>() {
                let label = channel.label().map(|value| value.to_string()).unwrap_or_default();
                if label == "control_channel" {
                    let events = events.clone();
                    channel.connect_on_message_string(move |_channel, message| {
                        if let Some(message) = message {
                            let _ = events.send(EventMessage::Log {
                                level: "debug".into(),
                                message: format!("control_channel {message}"),
                            });
                        }
                    });
                }
            }
            None
        });

        self.pipeline = Some(pipeline);
        self.webrtcbin = Some(webrtcbin);
        self.events.send(EventMessage::State {
            state: NativeStreamerState::Starting,
            detail: Some("native transport ready".into()),
        })?;
        Ok(())
    }

    fn apply_offer(&mut self, offer_sdp: &str) -> Result<()> {
        let config = self.config.clone().ok_or_else(|| anyhow!("missing native session config"))?;
        let _ = self.events.send(EventMessage::Log {
            level: "info".into(),
            message: format!("applying remote offer ({} chars)", offer_sdp.len()),
        });
        let fixed = fix_server_ip(offer_sdp, &config.session.server_ip);
        let preferred = prefer_codec(
            &fixed,
            &config.settings.codec,
            &CodecPreferenceOptions {
                prefer_hevc_profile_id: if config.settings.color_quality.starts_with("10bit") {
                    Some(2)
                } else {
                    Some(1)
                },
            },
        );
        self.partial_reliable_threshold_ms = parse_partial_reliable_threshold_ms(&preferred).unwrap_or(250);
        let offer = gst_sdp::SDPMessage::parse_buffer(preferred.as_bytes())?;
        let offer = gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, offer);
        let webrtcbin = self
            .webrtcbin
            .as_ref()
            .ok_or_else(|| anyhow!("webrtcbin not initialized"))?
            .clone();
        webrtcbin.emit_by_name::<()>("set-remote-description", &[&offer, &None::<gst::Promise>]);
        let _ = self.events.send(EventMessage::Log {
            level: "info".into(),
            message: "remote description applied".into(),
        });

        let server_ufrag = extract_ice_ufrag_from_offer(&preferred);
        for candidate in build_manual_ice_candidates(&config.session.media_connection_info, &server_ufrag) {
            let parts: Vec<_> = candidate.split('|').collect();
            let candidate_str = parts.first().copied().unwrap_or_default().to_string();
            let mid = parts.get(1).and_then(|value| value.parse::<u32>().ok()).unwrap_or(0);
            webrtcbin.emit_by_name::<()>("add-ice-candidate", &[&mid, &candidate_str]);
        }

        let events = self.events.clone();
        let config_for_answer = config.clone();
        let preferred_for_answer = preferred.clone();
        let webrtcbin_for_answer = webrtcbin.clone();
        let promise = gst::Promise::with_change_func(move |reply| {
            let Ok(Some(reply)) = reply else {
                let _ = events.send(EventMessage::Error {
                    code: "create_answer".into(),
                    message: "failed to receive answer promise".into(),
                    recoverable: false,
                });
                return;
            };
            let Ok(value) = reply.value("answer") else {
                let _ = events.send(EventMessage::Error {
                    code: "create_answer".into(),
                    message: "missing answer in promise".into(),
                    recoverable: false,
                });
                return;
            };
            let Ok(answer) = value.get::<gst_webrtc::WebRTCSessionDescription>() else {
                let _ = events.send(EventMessage::Error {
                    code: "create_answer".into(),
                    message: "invalid answer type".into(),
                    recoverable: false,
                });
                return;
            };
            webrtcbin_for_answer.emit_by_name::<()>("set-local-description", &[&answer, &None::<gst::Promise>]);
            let answer_text = answer.sdp().as_text().unwrap_or_default().to_string();
            let munged_answer = munge_answer_sdp(&answer_text, config_for_answer.settings.max_bitrate_kbps);
            let credentials = extract_ice_credentials(&preferred_for_answer);
            let (width, height) = parse_resolution(&config_for_answer.settings.resolution);
            let nvst = build_nvst_sdp(&NvstParams {
                width,
                height,
                fps: config_for_answer.settings.fps,
                max_bitrate_kbps: config_for_answer.settings.max_bitrate_kbps,
                partial_reliable_threshold_ms: parse_partial_reliable_threshold_ms(&preferred_for_answer).unwrap_or(250),
                codec: config_for_answer.settings.codec.clone(),
                color_quality: config_for_answer.settings.color_quality.clone(),
                credentials,
            });
            let _ = events.send(EventMessage::LocalAnswer {
                sdp: normalize_sdp_line_endings(&munged_answer),
                nvst_sdp: nvst,
            });
            let _ = events.send(EventMessage::Log {
                level: "info".into(),
                message: "local answer created".into(),
            });
        });
        webrtcbin.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
        self.events.send(EventMessage::State {
            state: NativeStreamerState::Connecting,
            detail: Some("remote offer applied".into()),
        })?;
        Ok(())
    }

    fn send_input_packet(&mut self, payload: InputPacketEnvelope) {
        let is_partial = matches!(payload, InputPacketEnvelope::MouseMove { .. } | InputPacketEnvelope::Gamepad { use_partially_reliable: true, .. });
        let encoded = {
            let mut encoder = self.input_encoder.lock().expect("input encoder poisoned");
            encoder.encode(&payload)
        };
        let bytes = glib::Bytes::from_owned(encoded);
        let channel = if is_partial {
            self.mouse_channel.as_ref()
        } else {
            self.reliable_channel.as_ref()
        };
        if let Some(channel) = channel {
            let _ = channel.send_data_full(Some(&bytes));
            let _ = self.events.send(EventMessage::Log {
                level: "debug".into(),
                message: format!(
                    "sent input packet via {} channel ({} bytes)",
                    if is_partial { "partial" } else { "reliable" },
                    bytes.len()
                ),
            });
            if let Ok(mut stats) = self.stats.lock() {
                stats.input_packets_sent += 1;
                let _ = self.events.send(EventMessage::Stats { stats: stats.clone() });
            }
        }
    }

    fn send_heartbeat_if_ready(&mut self) {
        if self.last_heartbeat.elapsed() < Duration::from_secs(2) {
            return;
        }
        self.last_heartbeat = Instant::now();
        if self.input_encoder.lock().expect("input encoder poisoned").protocol_version() > 0 {
            self.send_input_packet(InputPacketEnvelope::Heartbeat);
        }
    }

    fn drain_video_frames(&mut self) {
        while let Ok(frame) = self.frame_rx.try_recv() {
            let bytes = glib::Bytes::from_owned(frame.data);
            let texture = gdk::MemoryTexture::new(
                frame.width,
                frame.height,
                gdk::MemoryFormat::B8g8r8a8,
                &bytes,
                frame.stride,
            );
            self.picture.set_paintable(Some(&texture));
            self.announce_streaming_if_ready("first decoded video frame");
        }
    }

    fn poll_gamepads(&mut self) {
        let Some(gilrs) = self.gilrs.as_mut() else {
            return;
        };
        let mut pending = Vec::new();
        while let Some(event) = gilrs.next_event() {
            match event.event {
                EventType::Connected
                | EventType::Disconnected
                | EventType::ButtonPressed(_, _)
                | EventType::ButtonReleased(_, _)
                | EventType::AxisChanged(_, _, _) => {}
                _ => continue,
            }
            let snapshot = gamepad_snapshot(usize::from(event.id) as u32, &gilrs.gamepad(event.id));
            if self
                .last_gamepad_snapshot
                .get(&(usize::from(event.id) as u32))
                .map(|last| last == &snapshot)
                .unwrap_or(false)
            {
                continue;
            }
            self.last_gamepad_snapshot.insert(usize::from(event.id) as u32, snapshot.clone());
            if let Some(payload) = snapshot_to_packet(usize::from(event.id) as u32, &snapshot) {
                pending.push(payload);
            }
        }
        for payload in pending {
            self.send_input_packet(payload);
        }
    }

    fn stop_pipeline(&mut self) {
        if let Some(pipeline) = self.pipeline.take() {
            let _ = pipeline.set_state(gst::State::Null);
        }
        self.webrtcbin = None;
        self.reliable_channel = None;
        self.mouse_channel = None;
        self.bus_watch = None;
        self.streaming_announced = false;
    }

    fn announce_streaming_if_ready(&mut self, detail: &str) {
        if self.streaming_announced {
            return;
        }
        self.streaming_announced = true;
        let _ = self.events.send(EventMessage::State {
            state: NativeStreamerState::Streaming,
            detail: Some(detail.into()),
        });
    }
}

fn attach_video_branch(
    pipeline: &gst::Pipeline,
    src_pad: &gst::Pad,
    frame_tx: &Sender<VideoFrameUpdate>,
    stats: &Arc<Mutex<NativeStats>>,
    events: &Sender<EventMessage>,
) -> Result<()> {
    let queue = gst::ElementFactory::make("queue").build()?;
    let videoconvert = gst::ElementFactory::make("videoconvert").build()?;
    let capsfilter = gst::ElementFactory::make("capsfilter").build()?;
    let appsink = gst::ElementFactory::make("appsink").build()?.downcast::<AppSink>().unwrap();
    capsfilter.set_property(
        "caps",
        gst::Caps::builder("video/x-raw").field("format", "BGRA").build(),
    );
    appsink.set_property("sync", false);
    appsink.set_property("drop", true);
    appsink.set_property("max-buffers", 2u32);
    let frame_tx = frame_tx.clone();
    let stats = stats.clone();
    let events = events.clone();
    appsink.set_callbacks(
        AppSinkCallbacks::builder()
            .new_sample(move |sink: &AppSink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let Some(buffer) = sample.buffer() else {
                    return Err(gst::FlowError::Error);
                };
                let Some(caps) = sample.caps() else {
                    return Err(gst::FlowError::Error);
                };
                let info = VideoInfo::from_caps(caps).map_err(|_| gst::FlowError::Error)?;
                let frame = VideoFrameRef::from_buffer_ref_readable(buffer, &info).map_err(|_| gst::FlowError::Error)?;
                let plane = frame.plane_data(0).map_err(|_| gst::FlowError::Error)?;
                let _ = frame_tx.send(VideoFrameUpdate {
                    width: info.width() as i32,
                    height: info.height() as i32,
                    stride: info.stride()[0] as usize,
                    data: plane.to_vec(),
                });
                if let Ok(mut stats) = stats.lock() {
                    stats.frames_rendered += 1;
                    let _ = events.send(EventMessage::Stats { stats: stats.clone() });
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    pipeline.add(&queue)?;
    pipeline.add(&videoconvert)?;
    pipeline.add(&capsfilter)?;
    pipeline.add(appsink.upcast_ref::<gst::Element>())?;
    queue.link(&videoconvert)?;
    videoconvert.link(&capsfilter)?;
    capsfilter.link(appsink.upcast_ref::<gst::Element>())?;
    queue.sync_state_with_parent()?;
    videoconvert.sync_state_with_parent()?;
    capsfilter.sync_state_with_parent()?;
    appsink.sync_state_with_parent()?;
    let sink_pad = queue.static_pad("sink").ok_or_else(|| anyhow!("missing video queue sink pad"))?;
    src_pad.link(&sink_pad)?;
    Ok(())
}

fn attach_audio_branch(
    pipeline: &gst::Pipeline,
    src_pad: &gst::Pad,
    stats: &Arc<Mutex<NativeStats>>,
    events: &Sender<EventMessage>,
) -> Result<()> {
    let queue = gst::ElementFactory::make("queue").build()?;
    let audioconvert = gst::ElementFactory::make("audioconvert").build()?;
    let audioresample = gst::ElementFactory::make("audioresample").build()?;
    let identity = gst::ElementFactory::make("identity").build()?;
    let sink_name = env::var("OPENNOW_NATIVE_STREAMER_AUDIO_SINK").unwrap_or_else(|_| "autoaudiosink".into());
    let sink = gst::ElementFactory::make(&sink_name)
        .build()
        .or_else(|_| gst::ElementFactory::make("autoaudiosink").build())
        .or_else(|_| gst::ElementFactory::make("fakesink").build())?;
    identity.set_property("signal-handoffs", true);
    let stats_for_handoff = stats.clone();
    let events = events.clone();
    identity.connect("handoff", false, move |_| {
        if let Ok(mut stats) = stats_for_handoff.lock() {
            stats.audio_buffers += 1;
            let _ = events.send(EventMessage::Stats { stats: stats.clone() });
        }
        None
    });
    pipeline.add(&queue)?;
    pipeline.add(&audioconvert)?;
    pipeline.add(&audioresample)?;
    pipeline.add(&identity)?;
    pipeline.add(&sink)?;
    queue.link(&audioconvert)?;
    audioconvert.link(&audioresample)?;
    audioresample.link(&identity)?;
    identity.link(&sink)?;
    queue.sync_state_with_parent()?;
    audioconvert.sync_state_with_parent()?;
    audioresample.sync_state_with_parent()?;
    identity.sync_state_with_parent()?;
    sink.sync_state_with_parent()?;
    let sink_pad = queue.static_pad("sink").ok_or_else(|| anyhow!("missing audio queue sink pad"))?;
    src_pad.link(&sink_pad)?;
    Ok(())
}

fn create_data_channel(
    webrtcbin: &gst::Element,
    label: &str,
    ordered: bool,
    max_packet_lifetime: Option<i32>,
) -> Result<gst_webrtc::WebRTCDataChannel> {
    let mut structure = gst::Structure::builder("application/data-channel").field("ordered", ordered);
    if let Some(value) = max_packet_lifetime {
        structure = structure.field("max-packet-lifetime", value);
    }
    Ok(webrtcbin.emit_by_name::<gst_webrtc::WebRTCDataChannel>("create-data-channel", &[&label, &structure.build()]))
}

fn handle_input_handshake(
    bytes: &[u8],
    encoder: &Arc<Mutex<InputEncoder>>,
    events: &Sender<EventMessage>,
    stats: &Arc<Mutex<NativeStats>>,
) {
    if bytes.len() < 2 {
        return;
    }
    let first_word = u16::from_le_bytes([bytes[0], bytes[1]]);
    let version = if first_word == 526 {
        if bytes.len() >= 4 {
            u16::from_le_bytes([bytes[2], bytes[3]])
        } else {
            2
        }
    } else if bytes[0] == 0x0e {
        first_word
    } else {
        return;
    };

    let mut encoder = encoder.lock().expect("input encoder poisoned");
    if encoder.protocol_version() == 0 {
        encoder.set_protocol_version(version);
        let _ = events.send(EventMessage::Log {
            level: "info".into(),
            message: format!("input handshake complete (protocol v{version})"),
        });
        if let Ok(stats) = stats.lock() {
            let _ = events.send(EventMessage::Stats { stats: stats.clone() });
        }
    }
}

fn install_input_controllers(window: &gtk4::Window, picture: &gtk4::Picture, forwarder: InputForwarder) {
    let key = gtk4::EventControllerKey::new();
    let key_forwarder = forwarder.clone();
    key.connect_key_pressed(move |_controller, keyval, keycode, modifiers| {
        if let Some((vk, scancode)) = map_key(keyval, keycode) {
            key_forwarder.send(InputPacketEnvelope::Keyboard {
                down: true,
                keycode: vk,
                scancode,
                modifiers: map_modifiers(modifiers),
                timestamp_us: now_us(),
            });
        }
        gtk4::glib::Propagation::Stop
    });
    let key_forwarder = forwarder.clone();
    key.connect_key_released(move |_controller, keyval, keycode, modifiers| {
        if let Some((vk, scancode)) = map_key(keyval, keycode) {
            key_forwarder.send(InputPacketEnvelope::Keyboard {
                down: false,
                keycode: vk,
                scancode,
                modifiers: map_modifiers(modifiers),
                timestamp_us: now_us(),
            });
        }
    });
    window.add_controller(key);

    let motion = gtk4::EventControllerMotion::new();
    let last_position = Arc::new(Mutex::new(None::<(f64, f64)>));
    let motion_forwarder = forwarder.clone();
    let last_position_for_motion = last_position.clone();
    motion.connect_motion(move |_controller, x, y| {
        let mut last = last_position_for_motion.lock().expect("pointer position poisoned");
        if let Some((px, py)) = *last {
            let dx = (x - px).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            let dy = (y - py).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            if dx != 0 || dy != 0 {
                motion_forwarder.send(InputPacketEnvelope::MouseMove {
                    dx,
                    dy,
                    timestamp_us: now_us(),
                });
            }
        }
        *last = Some((x, y));
    });
    picture.add_controller(motion);

    let click = gtk4::GestureClick::new();
    let click_forwarder = forwarder.clone();
    click.connect_pressed(move |gesture, _count, _x, _y| {
        click_forwarder.send(InputPacketEnvelope::MouseButton {
            down: true,
            button: map_mouse_button(gesture.current_button()),
            timestamp_us: now_us(),
        });
    });
    let click_forwarder = forwarder.clone();
    click.connect_released(move |gesture, _count, _x, _y| {
        click_forwarder.send(InputPacketEnvelope::MouseButton {
            down: false,
            button: map_mouse_button(gesture.current_button()),
            timestamp_us: now_us(),
        });
    });
    picture.add_controller(click);

    let scroll = gtk4::EventControllerScroll::new(gtk4::EventControllerScrollFlags::VERTICAL);
    scroll.connect_scroll(move |_controller, _dx, dy| {
        forwarder.send(InputPacketEnvelope::MouseWheel {
            delta: (dy * 120.0).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16,
            timestamp_us: now_us(),
        });
        gtk4::glib::Propagation::Stop
    });
    picture.add_controller(scroll);
}

fn map_mouse_button(button: u32) -> u8 {
    match button {
        2 => 2,
        3 => 3,
        8 => 4,
        9 => 5,
        _ => 1,
    }
}

fn map_modifiers(modifiers: gdk::ModifierType) -> u16 {
    let mut out = 0u16;
    if modifiers.contains(gdk::ModifierType::SHIFT_MASK) {
        out |= 0x0001;
    }
    if modifiers.contains(gdk::ModifierType::CONTROL_MASK) {
        out |= 0x0002;
    }
    if modifiers.contains(gdk::ModifierType::ALT_MASK) {
        out |= 0x0004;
    }
    if modifiers.contains(gdk::ModifierType::SUPER_MASK) {
        out |= 0x0008;
    }
    out
}

fn map_key(keyval: gdk::Key, hardware_keycode: u32) -> Option<(u16, u16)> {
    let scancode = hardware_keycode.min(u16::MAX as u32) as u16;
    let vk = match keyval {
        gdk::Key::Escape => 0x1b,
        gdk::Key::Return => 0x0d,
        gdk::Key::Tab => 0x09,
        gdk::Key::space => 0x20,
        gdk::Key::BackSpace => 0x08,
        gdk::Key::Shift_L => 0xa0,
        gdk::Key::Shift_R => 0xa1,
        gdk::Key::Control_L => 0xa2,
        gdk::Key::Control_R => 0xa3,
        gdk::Key::Alt_L => 0xa4,
        gdk::Key::Alt_R => 0xa5,
        gdk::Key::Super_L => 0x5b,
        gdk::Key::Super_R => 0x5c,
        gdk::Key::Left => 0x25,
        gdk::Key::Up => 0x26,
        gdk::Key::Right => 0x27,
        gdk::Key::Down => 0x28,
        gdk::Key::Delete => 0x2e,
        gdk::Key::Insert => 0x2d,
        gdk::Key::Home => 0x24,
        gdk::Key::End => 0x23,
        gdk::Key::Page_Up => 0x21,
        gdk::Key::Page_Down => 0x22,
        gdk::Key::F1 => 0x70,
        gdk::Key::F2 => 0x71,
        gdk::Key::F3 => 0x72,
        gdk::Key::F4 => 0x73,
        gdk::Key::F5 => 0x74,
        gdk::Key::F6 => 0x75,
        gdk::Key::F7 => 0x76,
        gdk::Key::F8 => 0x77,
        gdk::Key::F9 => 0x78,
        gdk::Key::F10 => 0x79,
        gdk::Key::F11 => 0x7a,
        gdk::Key::F12 => 0x7b,
        other => other.to_unicode()?.to_ascii_uppercase() as u16,
    };
    Some((vk, scancode))
}

fn parse_resolution(value: &str) -> (u32, u32) {
    let mut parts = value.split('x');
    let width = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(1920);
    let height = parts.next().and_then(|value| value.parse::<u32>().ok()).unwrap_or(1080);
    (width, height)
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

fn gamepad_snapshot(id: u32, gamepad: &Gamepad<'_>) -> Vec<u8> {
    let buttons = [
        (Button::DPadUp, 0x0001),
        (Button::DPadDown, 0x0002),
        (Button::DPadLeft, 0x0004),
        (Button::DPadRight, 0x0008),
        (Button::Start, 0x0010),
        (Button::Select, 0x0020),
        (Button::LeftThumb, 0x0040),
        (Button::RightThumb, 0x0080),
        (Button::LeftTrigger, 0x0100),
        (Button::RightTrigger, 0x0200),
        (Button::South, 0x1000),
        (Button::East, 0x2000),
        (Button::West, 0x4000),
        (Button::North, 0x8000),
    ]
    .into_iter()
    .fold(0u16, |acc, (button, mask)| if gamepad.is_pressed(button) { acc | mask } else { acc });

    let mut out = Vec::new();
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&buttons.to_le_bytes());
    out.push(normalize_trigger(gamepad.value(Axis::LeftZ)));
    out.push(normalize_trigger(gamepad.value(Axis::RightZ)));
    out.extend_from_slice(&normalize_axis(gamepad.value(Axis::LeftStickX)).to_le_bytes());
    out.extend_from_slice(&normalize_axis(-gamepad.value(Axis::LeftStickY)).to_le_bytes());
    out.extend_from_slice(&normalize_axis(gamepad.value(Axis::RightStickX)).to_le_bytes());
    out.extend_from_slice(&normalize_axis(-gamepad.value(Axis::RightStickY)).to_le_bytes());
    out
}

fn snapshot_to_packet(id: u32, snapshot: &[u8]) -> Option<InputPacketEnvelope> {
    if snapshot.len() < 16 {
        return None;
    }
    Some(InputPacketEnvelope::Gamepad {
        controller_id: id as u16,
        buttons: u16::from_le_bytes(snapshot[4..6].try_into().ok()?),
        left_trigger: snapshot[6],
        right_trigger: snapshot[7],
        left_stick_x: i16::from_le_bytes(snapshot[8..10].try_into().ok()?),
        left_stick_y: i16::from_le_bytes(snapshot[10..12].try_into().ok()?),
        right_stick_x: i16::from_le_bytes(snapshot[12..14].try_into().ok()?),
        right_stick_y: i16::from_le_bytes(snapshot[14..16].try_into().ok()?),
        bitmap: 1,
        use_partially_reliable: true,
        timestamp_us: now_us(),
    })
}

fn normalize_axis(value: f32) -> i16 {
    (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn normalize_trigger(value: f32) -> u8 {
    (((value + 1.0) * 0.5).clamp(0.0, 1.0) * 255.0) as u8
}
