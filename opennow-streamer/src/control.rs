use anyhow::Context;
use serde::Serialize;
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, net::TcpStream, sync::mpsc};

use crate::messages::{ControlMessage, StreamerMessage};

pub async fn connect(control_url: &str) -> anyhow::Result<(mpsc::Sender<StreamerMessage>, mpsc::Receiver<ControlMessage>)> {
    let addr = control_url.strip_prefix("tcp://").unwrap_or(control_url);
    let stream = TcpStream::connect(addr).await.with_context(|| format!("failed to connect control socket {addr}"))?;
    let (read_half, mut write_half) = stream.into_split();
    let (to_writer_tx, mut to_writer_rx) = mpsc::channel::<StreamerMessage>(128);
    let (from_reader_tx, from_reader_rx) = mpsc::channel::<ControlMessage>(128);

    tokio::spawn(async move {
        while let Some(message) = to_writer_rx.recv().await {
            let line = match serde_json::to_vec(&message) {
                Ok(mut line) => {
                    line.push(b'\n');
                    line
                }
                Err(_) => break,
            };
            if write_half.write_all(&line).await.is_err() {
                break;
            }
        }
    });

    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<ControlMessage>(&line) {
                        Ok(message) => {
                            if from_reader_tx.send(message).await.is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            log::error!("invalid control message: {error}");
                        }
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
    });

    Ok((to_writer_tx, from_reader_rx))
}

pub async fn send<T: Serialize>(sender: &mpsc::Sender<T>, message: T) {
    let _ = sender.send(message).await;
}
