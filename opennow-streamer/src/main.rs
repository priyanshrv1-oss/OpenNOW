mod control;
mod input;
mod media;
mod messages;
mod sdp;
mod session;
mod window;

use std::{sync::{Arc, mpsc}, thread};

use anyhow::Context;
use tokio::sync::mpsc as tokio_mpsc;

use clap::Parser;
use tokio::{runtime::Builder, sync::Mutex};

use crate::{
    control::{connect, send},
    media::MediaEvent,
    messages::{StreamerMessage, StreamerState},
    session::{handle_control_message, InputPayload, SharedSession},
};

#[derive(Parser, Debug, Clone)]
struct Args {
    #[arg(long)]
    control_url: String,
}

fn main() -> anyhow::Result<()> {
    env_logger::init();
    let args = Args::parse();
    let active: SharedSession = Arc::new(Mutex::new(None));
    let (media_tx, media_rx) = mpsc::channel::<MediaEvent>();
    let (input_tx, input_rx) = tokio_mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = tokio_mpsc::unbounded_channel::<()>();

    if cfg!(target_os = "macos") {
        let runtime_active = active.clone();
        let runtime_media_tx = media_tx.clone();
        let runtime_thread = thread::spawn(move || {
            let runtime = Builder::new_multi_thread()
                .enable_all()
                .build()
                .context("build tokio runtime")
                .and_then(|rt| rt.block_on(run_runtime(args, runtime_active, runtime_media_tx, input_rx, shutdown_rx)));
            if let Err(error) = runtime {
                eprintln!("runtime loop failed: {error:#}");
            }
        });

        let result = window::run(active, media_rx, input_tx, 1920, 1080);
        let _ = shutdown_tx.send(());
        let _ = runtime_thread.join();
        return result;
    }

    let window_session = active.clone();
    thread::spawn(move || {
        if let Err(error) = window::run(window_session, media_rx, input_tx, 1920, 1080) {
            eprintln!("window loop failed: {error:#}");
        }
    });

    let runtime = Builder::new_multi_thread().enable_all().build().context("build tokio runtime")?;
    runtime.block_on(run_runtime(args, active, media_tx, input_rx, shutdown_rx))
}

async fn run_runtime(
    args: Args,
    active: SharedSession,
    media_tx: mpsc::Sender<MediaEvent>,
    mut input_rx: tokio_mpsc::UnboundedReceiver<InputPayload>,
    mut shutdown_rx: tokio_mpsc::UnboundedReceiver<()>,
) -> anyhow::Result<()> {
    let (control_tx, mut control_rx) = connect(&args.control_url).await?;
    send(&control_tx, StreamerMessage::Hello { version: 1, pid: std::process::id() }).await;
    send(&control_tx, StreamerMessage::State { state: StreamerState::Idle, detail: Some("booted".into()) }).await;

    loop {
        tokio::select! {
            maybe_shutdown = shutdown_rx.recv() => {
                if maybe_shutdown.is_some() {
                    if let Some(session) = active.lock().await.take() {
                        session.close().await;
                    }
                    break;
                }
            }
            maybe_payload = input_rx.recv() => {
                match maybe_payload {
                    Some(payload) => {
                        if let Some(active_session) = active.lock().await.clone() {
                            active_session.send_input(payload).await;
                        }
                    }
                    None => break,
                }
            }
            maybe_message = control_rx.recv() => {
                match maybe_message {
                    Some(message) => {
                        if let Err(error) = handle_control_message(&active, &control_tx, &media_tx, message).await {
                            let _ = control_tx.send(StreamerMessage::State {
                                state: StreamerState::Failed,
                                detail: Some(error.to_string()),
                            }).await;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    Ok(())
}
