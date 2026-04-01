mod control;
mod input;
mod media;
mod messages;
mod sdp;
mod session;
mod window;

use std::sync::{Arc, mpsc};

use clap::Parser;
use tokio::sync::Mutex;

use crate::{
    control::{connect, send},
    media::MediaEvent,
    messages::{StreamerMessage, StreamerState},
    session::{handle_control_message, SharedSession},
};

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    control_url: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    env_logger::init();
    let args = Args::parse();
    let (control_tx, mut control_rx) = connect(&args.control_url).await?;
    send(&control_tx, StreamerMessage::Hello { version: 1, pid: std::process::id() }).await;
    send(&control_tx, StreamerMessage::State { state: StreamerState::Idle, detail: Some("booted".into()) }).await;

    let active: SharedSession = Arc::new(Mutex::new(None));
    let window_session = active.clone();
    let (media_tx, media_rx) = mpsc::channel::<MediaEvent>();
    std::thread::spawn(move || {
        if let Err(error) = window::run(window_session, media_rx, 1920, 1080) {
            eprintln!("window loop failed: {error:#}");
        }
    });

    while let Some(message) = control_rx.recv().await {
        if let Err(error) = handle_control_message(&active, &control_tx, &media_tx, message).await {
            let _ = control_tx
                .send(StreamerMessage::State {
                    state: StreamerState::Failed,
                    detail: Some(error.to_string()),
                })
                .await;
        }
    }

    Ok(())
}
