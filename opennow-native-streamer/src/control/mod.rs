use std::sync::mpsc::{self, Receiver};

use crate::{
    ipc::{ControlMessage, EventMessage},
    media::MediaRuntime,
};

pub struct NativeStreamerController {
    media: MediaRuntime,
    event_rx: Receiver<EventMessage>,
    started: bool,
}

impl NativeStreamerController {
    pub fn new() -> Result<Self, String> {
        let (event_tx, event_rx) = mpsc::channel();
        let media = MediaRuntime::new(event_tx).map_err(|error| error.to_string())?;
        Ok(Self {
            media,
            event_rx,
            started: false,
        })
    }

    pub fn bootstrap(&mut self) -> Result<(), String> {
        self.media
            .bootstrap("OpenNOW Native Streamer".into())
            .map_err(|error| error.to_string())?;
        self.started = true;
        Ok(())
    }

    pub fn handle(&mut self, message: ControlMessage) -> Result<bool, String> {
        match message {
            ControlMessage::Hello { .. } | ControlMessage::HelloAck { .. } => {}
            ControlMessage::Ping => {
                self.media
                    .send_input(crate::input::protocol::InputPacketEnvelope::Heartbeat)
                    .map_err(|error| error.to_string())?;
            }
            ControlMessage::StartSession { payload } => {
                self.media.start_session(payload).map_err(|error| error.to_string())?;
            }
            ControlMessage::StopSession { reason } => {
                self.media.stop(reason).map_err(|error| error.to_string())?;
                return Ok(false);
            }
            ControlMessage::SignalingOffer { sdp } => {
                self.media.apply_offer(sdp).map_err(|error| error.to_string())?;
            }
            ControlMessage::RemoteIce { candidate } => {
                self.media.add_remote_ice(candidate).map_err(|error| error.to_string())?;
            }
            ControlMessage::Input { payload } => {
                self.media.send_input(payload).map_err(|error| error.to_string())?;
            }
        }
        Ok(true)
    }

    pub fn drain_events(&mut self) -> Vec<EventMessage> {
        let mut out = Vec::new();
        while let Ok(event) = self.event_rx.try_recv() {
            out.push(event);
        }
        out
    }
}
