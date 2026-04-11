use std::{env, io::{Read, Write}, process, thread, time::Duration};

use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};

use opennow_native_streamer::{
    control::NativeStreamerController,
    ipc::{encode_frame, ControlMessage, EventMessage, FrameDecoder, PROTOCOL_VERSION},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    opennow_native_streamer::logging::init();
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|arg| arg == "--help") {
        println!("opennow-native-streamer --ipc-endpoint <path>");
        return Ok(());
    }
    let endpoint = args
        .windows(2)
        .find_map(|pair| if pair[0] == "--ipc-endpoint" { Some(pair[1].clone()) } else { None })
        .ok_or("missing --ipc-endpoint")?;

    let name = endpoint.to_fs_name::<GenericFilePath>()?;
    let mut stream = Stream::connect(name)?;
    stream.set_nonblocking(true)?;

    let hello = ControlMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        process_id: process::id(),
    };
    stream.write_all(&encode_frame(&hello)?)?;

    let mut controller = NativeStreamerController::new().map_err(|err| format!("controller init failed: {err}"))?;
    controller.bootstrap().map_err(|err| format!("controller bootstrap failed: {err}"))?;

    let mut decoder = FrameDecoder::default();
    let mut read_buf = [0u8; 8192];
    let mut running = true;

    while running {
        match stream.read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => {
                decoder.push(&read_buf[..n]);
                while let Some(message) = decoder.try_next::<ControlMessage>()? {
                    running = controller.handle(message).map_err(|err| format!("controller handle failed: {err}"))?;
                    if !running {
                        break;
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(Box::new(error)),
        }

        for event in controller.drain_events() {
            write_event(&mut stream, &event)?;
        }

        thread::sleep(Duration::from_millis(8));
    }

    Ok(())
}

fn write_event(stream: &mut Stream, event: &EventMessage) -> Result<(), Box<dyn std::error::Error>> {
    let frame = encode_frame(event)?;
    stream.write_all(&frame)?;
    Ok(())
}
