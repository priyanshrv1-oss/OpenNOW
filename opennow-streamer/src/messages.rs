use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaConnectionInfo {
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub server_ip: String,
    pub signaling_server: String,
    #[serde(default)]
    pub signaling_url: Option<String>,
    pub ice_servers: Vec<IceServer>,
    #[serde(default)]
    pub media_connection_info: Option<MediaConnectionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSettings {
    pub resolution: String,
    pub fps: u16,
    pub max_bitrate_mbps: u16,
    pub codec: String,
    pub color_quality: String,
    #[serde(default, alias = "enableL4S", alias = "enableL4s")]
    pub enable_l4s: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ControlMessage {
    Configure { session: SessionInfo, settings: StreamSettings },
    SignalingOffer { sdp: String },
    SignalingRemoteIce {
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_m_line_index: Option<u16>,
    },
    Stop,
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum StreamerMessage {
    Hello { version: u32, pid: u32 },
    Log { level: String, message: String },
    State { state: StreamerState, detail: Option<String> },
    Answer {
        sdp: String,
        #[serde(rename = "nvstSdp")]
        nvst_sdp: String,
    },
    LocalIce {
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_m_line_index: Option<u16>,
    },
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StreamerState {
    Idle,
    Connecting,
    Connected,
    Disconnected,
    Failed,
}
