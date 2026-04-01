use std::{
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc::Sender, Arc},
    thread,
};

use anyhow::{anyhow, Context};
use bytes::Bytes;
use opus::{Channels, Decoder as OpusDecoder};
use rtp::{
    codecs::{h264::H264Packet, h265::{H265Packet, H265Payload}},
    packetizer::Depacketizer,
};
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

use crate::messages::StreamerMessage;

#[derive(Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone)]
pub struct AudioFrame {
    pub samples: Vec<i16>,
    pub channels: u8,
    pub sample_rate: u32,
}

#[derive(Clone)]
pub enum MediaEvent {
    Video(VideoFrame),
    Audio(AudioFrame),
}

#[derive(Clone)]
pub struct MediaPipeline {
    event_tx: Sender<MediaEvent>,
    log_tx: tokio::sync::mpsc::Sender<StreamerMessage>,
    video_settings: VideoSettings,
}

#[derive(Clone)]
pub struct VideoSettings {
    pub width: u32,
    pub height: u32,
    pub codec: String,
}

impl MediaPipeline {
    pub fn new(event_tx: Sender<MediaEvent>, log_tx: tokio::sync::mpsc::Sender<StreamerMessage>, video_settings: VideoSettings) -> Self {
        Self { event_tx, log_tx, video_settings }
    }

    pub async fn attach_video_track(&self, track: Arc<webrtc::track::track_remote::TrackRemote>) -> anyhow::Result<()> {
        let codec = track.codec().capability;
        let mime = codec.mime_type.to_lowercase();
        let event_tx = self.event_tx.clone();
        let log_tx = self.log_tx.clone();
        let settings = self.video_settings.clone();
        tokio::spawn(async move {
            if let Err(error) = run_video_track(track, codec, settings, event_tx, log_tx.clone()).await {
                let _ = log_tx.send(StreamerMessage::Error { message: format!("video pipeline failed: {error:#}") }).await;
            }
        });
        let _ = self.log_tx.send(StreamerMessage::Log { level: "info".into(), message: format!("attached video track {mime}") }).await;
        Ok(())
    }

    pub async fn attach_audio_track(&self, track: Arc<webrtc::track::track_remote::TrackRemote>) -> anyhow::Result<()> {
        let codec = track.codec().capability;
        let event_tx = self.event_tx.clone();
        let log_tx = self.log_tx.clone();
        tokio::spawn(async move {
            if let Err(error) = run_audio_track(track, codec, event_tx, log_tx.clone()).await {
                let _ = log_tx.send(StreamerMessage::Error { message: format!("audio pipeline failed: {error:#}") }).await;
            }
        });
        Ok(())
    }
}

async fn run_video_track(
    track: Arc<webrtc::track::track_remote::TrackRemote>,
    codec: RTCRtpCodecCapability,
    settings: VideoSettings,
    event_tx: Sender<MediaEvent>,
    log_tx: tokio::sync::mpsc::Sender<StreamerMessage>,
) -> anyhow::Result<()> {
    let codec_name = codec.mime_type.to_lowercase();
    let ffmpeg_demuxer = if codec_name.contains("h265") || codec_name.contains("hevc") {
        "hevc"
    } else if codec_name.contains("h264") {
        "h264"
    } else {
        return Err(anyhow!("unsupported video codec for MVP decode path: {}", codec.mime_type));
    };

    let mut decoder = FfmpegVideoDecoder::spawn(ffmpeg_demuxer, settings.width, settings.height, event_tx, log_tx.clone())?;
    let mut h264 = H264Packet::default();
    let mut h265 = H265Assembler::default();
    loop {
        let (packet, _) = track.read_rtp().await.context("read_rtp video")?;
        let payload = if ffmpeg_demuxer == "h264" {
            match h264.depacketize(&packet.payload) {
                Ok(bytes) if !bytes.is_empty() => bytes.as_ref().to_vec(),
                Ok(_) => Vec::new(),
                Err(error) => {
                    let _ = log_tx.send(StreamerMessage::Log { level: "warn".into(), message: format!("h264 depacketize: {error}") }).await;
                    Vec::new()
                }
            }
        } else {
            match h265.push(packet.payload.clone()) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = log_tx.send(StreamerMessage::Log { level: "warn".into(), message: format!("h265 depacketize: {error}") }).await;
                    Vec::new()
                }
            }
        };
        if !payload.is_empty() {
            decoder.write(&payload)?;
        }
    }
}

async fn run_audio_track(
    track: Arc<webrtc::track::track_remote::TrackRemote>,
    codec: RTCRtpCodecCapability,
    event_tx: Sender<MediaEvent>,
    _log_tx: tokio::sync::mpsc::Sender<StreamerMessage>,
) -> anyhow::Result<()> {
    if !codec.mime_type.to_lowercase().contains("opus") {
        return Err(anyhow!("unsupported audio codec for MVP decode path: {}", codec.mime_type));
    }
    let sample_rate = codec.clock_rate.max(48_000);
    let channels = if codec.channels == 0 { 2 } else { codec.channels as usize };
    let mut depacketizer = rtp::codecs::opus::OpusPacket::default();
    let mut decoder = OpusDecoder::new(sample_rate, if channels > 1 { Channels::Stereo } else { Channels::Mono })?;
    let mut pcm = vec![0_i16; 960 * channels * 6];
    loop {
        let (packet, _) = track.read_rtp().await.context("read_rtp audio")?;
        let opus = depacketizer.depacketize(&packet.payload).context("depacketize opus")?;
        let frame_samples = decoder.decode(&opus, &mut pcm, false).context("decode opus")?;
        if frame_samples > 0 {
            let used = frame_samples * channels;
            let samples = pcm[..used].to_vec();
            let _ = event_tx.send(MediaEvent::Audio(AudioFrame { samples, channels: channels as u8, sample_rate }));
        }
    }
}

struct FfmpegVideoDecoder {
    stdin: ChildStdin,
    _child: Child,
}

impl FfmpegVideoDecoder {
    fn spawn(
        demuxer: &str,
        width: u32,
        height: u32,
        event_tx: Sender<MediaEvent>,
        log_tx: tokio::sync::mpsc::Sender<StreamerMessage>,
    ) -> anyhow::Result<Self> {
        let ffmpeg = resolve_ffmpeg_binary()?;
        let mut child = Command::new(ffmpeg)
            .args([
                "-loglevel", "error",
                "-fflags", "nobuffer",
                "-flags", "low_delay",
                "-probesize", "32",
                "-analyzeduration", "0",
                "-f", demuxer,
                "-i", "pipe:0",
                "-f", "rawvideo",
                "-pix_fmt", "rgb24",
                "pipe:1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("spawn ffmpeg video decoder")?;
        let frame_size = (width * height * 3) as usize;
        let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("missing ffmpeg stdout"))?;
        let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("missing ffmpeg stderr"))?;
        thread::spawn(move || {
            let mut buffer = vec![0_u8; frame_size];
            while stdout.read_exact(&mut buffer).is_ok() {
                let _ = event_tx.send(MediaEvent::Video(VideoFrame { width, height, pixels: buffer.clone() }));
            }
        });
        thread::spawn(move || {
            let mut stderr_buf = String::new();
            let _ = stderr.read_to_string(&mut stderr_buf);
            if !stderr_buf.trim().is_empty() {
                let _ = log_tx.blocking_send(StreamerMessage::Log { level: "stderr".into(), message: stderr_buf });
            }
        });
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("missing ffmpeg stdin"))?;
        Ok(Self { stdin, _child: child })
    }

    fn write(&mut self, payload: &[u8]) -> anyhow::Result<()> {
        self.stdin.write_all(payload).context("write ffmpeg stdin")?;
        Ok(())
    }
}

#[derive(Default)]
struct H265Assembler {
    packet: H265Packet,
    fu_buffer: Vec<u8>,
}

impl H265Assembler {
    fn push(&mut self, payload: Bytes) -> anyhow::Result<Vec<u8>> {
        self.packet.depacketize(&payload)?;
        match self.packet.payload() {
            H265Payload::H265SingleNALUnitPacket(packet) => {
                let mut out = vec![0, 0, 0, 1];
                out.extend_from_slice(&packet.payload_header().0.to_be_bytes());
                out.extend_from_slice(&packet.payload());
                Ok(out)
            }
            H265Payload::H265AggregationPacket(packet) => {
                let mut out = Vec::new();
                if let Some(first) = packet.first_unit() {
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    let nal: Bytes = first.nal_unit();
                    out.extend_from_slice(nal.as_ref());
                }
                for unit in packet.other_units() {
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    let nal: Bytes = unit.nal_unit();
                    out.extend_from_slice(nal.as_ref());
                }
                Ok(out)
            }
            H265Payload::H265FragmentationUnitPacket(packet) => {
                if packet.fu_header().s() {
                    self.fu_buffer.clear();
                    self.fu_buffer.extend_from_slice(&[0, 0, 0, 1]);
                    let header = packet.payload_header();
                    let reconstructed0 = ((header.f() as u8) << 7) | ((packet.fu_header().fu_type() & 0x3F) << 1) | (header.layer_id() & 0x01);
                    let reconstructed1 = ((header.layer_id() as u8) << 3) | (header.tid() & 0x07);
                    self.fu_buffer.push(reconstructed0);
                    self.fu_buffer.push(reconstructed1);
                }
                self.fu_buffer.extend_from_slice(&packet.payload());
                if packet.fu_header().e() {
                    Ok(std::mem::take(&mut self.fu_buffer))
                } else {
                    Ok(Vec::new())
                }
            }
            H265Payload::H265PACIPacket(packet) => {
                let mut out = vec![0, 0, 0, 1];
                out.extend_from_slice(&packet.payload());
                Ok(out)
            }
        }
    }
}

fn resolve_ffmpeg_binary() -> anyhow::Result<PathBuf> {
    if let Ok(path) = env::var("OPENNOW_FFMPEG_BIN") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    let exe = env::current_exe().context("current_exe")?;
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let candidates = [
        exe.parent().map(|p| p.join(format!("ffmpeg{suffix}"))),
        exe.parent().and_then(Path::parent).map(|p| p.join("bin").join(format!("ffmpeg{suffix}"))),
        Some(PathBuf::from(format!("ffmpeg{suffix}"))),
    ];
    candidates.into_iter().flatten().find(|candidate| candidate.exists() || candidate == &PathBuf::from(format!("ffmpeg{suffix}"))).ok_or_else(|| anyhow!("unable to locate bundled ffmpeg runtime"))
}
