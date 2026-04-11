use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::{input::protocol::InputPacketEnvelope, session::types::NativeSessionConfig};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlMessage {
    Hello {
        protocol_version: u32,
        process_id: u32,
    },
    HelloAck {
        protocol_version: u32,
        instance_id: String,
    },
    StartSession {
        payload: NativeSessionConfig,
    },
    StopSession {
        reason: Option<String>,
    },
    SignalingOffer {
        sdp: String,
    },
    RemoteIce {
        candidate: IceCandidate,
    },
    Input {
        payload: InputPacketEnvelope,
    },
    Ping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventMessage {
    Ready,
    State {
        state: NativeStreamerState,
        detail: Option<String>,
    },
    LocalAnswer {
        sdp: String,
        nvst_sdp: String,
    },
    LocalIce {
        candidate: IceCandidate,
    },
    Stats {
        stats: NativeStats,
    },
    Log {
        level: String,
        message: String,
    },
    Error {
        code: String,
        message: String,
        recoverable: bool,
    },
    Stopped {
        reason: Option<String>,
    },
    Pong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u32>,
    pub username_fragment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeStreamerState {
    Booting,
    Idle,
    Starting,
    AwaitingOffer,
    Connecting,
    Streaming,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NativeStats {
    pub frames_rendered: u64,
    pub audio_buffers: u64,
    pub input_packets_sent: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameCodecError {
    #[error("frame too large")]
    FrameTooLarge,
    #[error("invalid length {0}")]
    InvalidLength(u32),
    #[error("truncated frame")]
    Truncated,
    #[error("invalid json: {0}")]
    InvalidJson(String),
}

pub fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, FrameCodecError> {
    let payload = serde_json::to_vec(message).map_err(|error| FrameCodecError::InvalidJson(error.to_string()))?;
    let len: u32 = payload.len().try_into().map_err(|_| FrameCodecError::FrameTooLarge)?;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

#[derive(Default)]
pub struct FrameDecoder {
    buffer: VecDeque<u8>,
}

impl FrameDecoder {
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend(chunk.iter().copied());
    }

    pub fn try_next<T>(&mut self) -> Result<Option<T>, FrameCodecError>
    where
        T: for<'de> Deserialize<'de>,
    {
        if self.buffer.len() < 4 {
            return Ok(None);
        }
        let header = [self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]];
        let len = u32::from_be_bytes(header);
        if len > 8 * 1024 * 1024 {
            return Err(FrameCodecError::InvalidLength(len));
        }
        let needed = 4usize + len as usize;
        if self.buffer.len() < needed {
            return Ok(None);
        }
        for _ in 0..4 {
            self.buffer.pop_front();
        }
        let mut payload = vec![0u8; len as usize];
        for byte in &mut payload {
            *byte = self.buffer.pop_front().ok_or(FrameCodecError::Truncated)?;
        }
        serde_json::from_slice(&payload)
            .map(Some)
            .map_err(|error| FrameCodecError::InvalidJson(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn round_trips_json_frame() {
        let message = ControlMessage::Ping;
        let frame = encode_frame(&message).unwrap();
        let mut decoder = FrameDecoder::default();
        decoder.push(&frame[..3]);
        assert_eq!(decoder.try_next::<ControlMessage>().unwrap(), None);
        decoder.push(&frame[3..]);
        assert_eq!(decoder.try_next::<ControlMessage>().unwrap(), Some(message));
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut decoder = FrameDecoder::default();
        decoder.push(&9_999_999u32.to_be_bytes());
        let err = decoder.try_next::<ControlMessage>().unwrap_err();
        assert!(matches!(err, FrameCodecError::InvalidLength(_)));
    }
}
