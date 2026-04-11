use serde::{Deserialize, Serialize};

pub const INPUT_HEARTBEAT: u32 = 2;
pub const INPUT_KEY_DOWN: u32 = 3;
pub const INPUT_KEY_UP: u32 = 4;
pub const INPUT_MOUSE_REL: u32 = 7;
pub const INPUT_MOUSE_BUTTON_DOWN: u32 = 8;
pub const INPUT_MOUSE_BUTTON_UP: u32 = 9;
pub const INPUT_MOUSE_WHEEL: u32 = 10;
pub const INPUT_GAMEPAD: u32 = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputPacketEnvelope {
    Heartbeat,
    Keyboard {
        down: bool,
        keycode: u16,
        scancode: u16,
        modifiers: u16,
        timestamp_us: u64,
    },
    MouseMove {
        dx: i16,
        dy: i16,
        timestamp_us: u64,
    },
    MouseButton {
        down: bool,
        button: u8,
        timestamp_us: u64,
    },
    MouseWheel {
        delta: i16,
        timestamp_us: u64,
    },
    Gamepad {
        controller_id: u16,
        buttons: u16,
        left_trigger: u8,
        right_trigger: u8,
        left_stick_x: i16,
        left_stick_y: i16,
        right_stick_x: i16,
        right_stick_y: i16,
        bitmap: u16,
        use_partially_reliable: bool,
        timestamp_us: u64,
    },
}

#[derive(Default)]
pub struct InputEncoder {
    protocol_version: u16,
    seq: [u16; 4],
}

impl InputEncoder {
    pub fn set_protocol_version(&mut self, version: u16) {
        self.protocol_version = version;
    }

    pub fn protocol_version(&self) -> u16 {
        self.protocol_version
    }

    pub fn encode(&mut self, envelope: &InputPacketEnvelope) -> Vec<u8> {
        match envelope {
            InputPacketEnvelope::Heartbeat => INPUT_HEARTBEAT.to_le_bytes().to_vec(),
            InputPacketEnvelope::Keyboard { down, keycode, scancode, modifiers, timestamp_us } => {
                let mut bytes = vec![0u8; 18];
                bytes[0..4].copy_from_slice(&(if *down { INPUT_KEY_DOWN } else { INPUT_KEY_UP }).to_le_bytes());
                bytes[4..6].copy_from_slice(&keycode.to_be_bytes());
                bytes[6..8].copy_from_slice(&modifiers.to_be_bytes());
                bytes[8..10].copy_from_slice(&scancode.to_be_bytes());
                bytes[10..18].copy_from_slice(&timestamp_us.to_be_bytes());
                self.wrap_single(bytes)
            }
            InputPacketEnvelope::MouseMove { dx, dy, timestamp_us } => {
                let mut bytes = vec![0u8; 22];
                bytes[0..4].copy_from_slice(&INPUT_MOUSE_REL.to_le_bytes());
                bytes[4..6].copy_from_slice(&dx.to_be_bytes());
                bytes[6..8].copy_from_slice(&dy.to_be_bytes());
                bytes[14..22].copy_from_slice(&timestamp_us.to_be_bytes());
                self.wrap_batched(bytes)
            }
            InputPacketEnvelope::MouseButton { down, button, timestamp_us } => {
                let mut bytes = vec![0u8; 18];
                bytes[0..4].copy_from_slice(&(if *down { INPUT_MOUSE_BUTTON_DOWN } else { INPUT_MOUSE_BUTTON_UP }).to_le_bytes());
                bytes[4] = *button;
                bytes[10..18].copy_from_slice(&timestamp_us.to_be_bytes());
                self.wrap_single(bytes)
            }
            InputPacketEnvelope::MouseWheel { delta, timestamp_us } => {
                let mut bytes = vec![0u8; 22];
                bytes[0..4].copy_from_slice(&INPUT_MOUSE_WHEEL.to_le_bytes());
                bytes[6..8].copy_from_slice(&delta.to_be_bytes());
                bytes[14..22].copy_from_slice(&timestamp_us.to_be_bytes());
                self.wrap_single(bytes)
            }
            InputPacketEnvelope::Gamepad {
                controller_id,
                buttons,
                left_trigger,
                right_trigger,
                left_stick_x,
                left_stick_y,
                right_stick_x,
                right_stick_y,
                bitmap,
                use_partially_reliable,
                timestamp_us,
            } => {
                let mut bytes = vec![0u8; 38];
                bytes[0..4].copy_from_slice(&INPUT_GAMEPAD.to_le_bytes());
                bytes[4..6].copy_from_slice(&26u16.to_le_bytes());
                bytes[6..8].copy_from_slice(&controller_id.to_le_bytes());
                bytes[8..10].copy_from_slice(&bitmap.to_le_bytes());
                bytes[10..12].copy_from_slice(&20u16.to_le_bytes());
                bytes[12..14].copy_from_slice(&buttons.to_le_bytes());
                let triggers = (*left_trigger as u16) | ((*right_trigger as u16) << 8);
                bytes[14..16].copy_from_slice(&triggers.to_le_bytes());
                bytes[16..18].copy_from_slice(&left_stick_x.to_le_bytes());
                bytes[18..20].copy_from_slice(&left_stick_y.to_le_bytes());
                bytes[20..22].copy_from_slice(&right_stick_x.to_le_bytes());
                bytes[22..24].copy_from_slice(&right_stick_y.to_le_bytes());
                bytes[26..28].copy_from_slice(&85u16.to_le_bytes());
                bytes[30..38].copy_from_slice(&timestamp_us.to_be_bytes());
                if *use_partially_reliable {
                    self.wrap_gamepad_pr(*controller_id as usize, bytes)
                } else {
                    self.wrap_batched(bytes)
                }
            }
        }
    }

    fn wrap_single(&self, payload: Vec<u8>) -> Vec<u8> {
        if self.protocol_version <= 2 {
            return payload;
        }
        let mut wrapped = vec![0x23];
        wrapped.extend_from_slice(&0u64.to_be_bytes());
        wrapped.push(0x22);
        wrapped.extend_from_slice(&payload);
        wrapped
    }

    fn wrap_batched(&self, payload: Vec<u8>) -> Vec<u8> {
        if self.protocol_version <= 2 {
            return payload;
        }
        let mut wrapped = vec![0x23];
        wrapped.extend_from_slice(&0u64.to_be_bytes());
        wrapped.push(0x21);
        wrapped.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        wrapped.extend_from_slice(&payload);
        wrapped
    }

    fn wrap_gamepad_pr(&mut self, index: usize, payload: Vec<u8>) -> Vec<u8> {
        if self.protocol_version <= 2 {
            return payload;
        }
        let slot = index % self.seq.len();
        let seq = self.seq[slot].wrapping_add(1);
        self.seq[slot] = seq;
        let mut wrapped = vec![0x23];
        wrapped.extend_from_slice(&0u64.to_be_bytes());
        wrapped.push(0x26);
        wrapped.push(slot as u8);
        wrapped.extend_from_slice(&seq.to_be_bytes());
        wrapped.push(0x21);
        wrapped.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        wrapped.extend_from_slice(&payload);
        wrapped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_keyboard_with_v3_wrapper() {
        let mut enc = InputEncoder::default();
        enc.set_protocol_version(3);
        let packet = enc.encode(&InputPacketEnvelope::Keyboard {
            down: true,
            keycode: 0x41,
            scancode: 0x04,
            modifiers: 0x02,
            timestamp_us: 10,
        });
        assert_eq!(packet[0], 0x23);
        assert_eq!(packet[9], 0x22);
        assert_eq!(&packet[10..14], &INPUT_KEY_DOWN.to_le_bytes());
    }

    #[test]
    fn encodes_gamepad_partially_reliable_header() {
        let mut enc = InputEncoder::default();
        enc.set_protocol_version(3);
        let packet = enc.encode(&InputPacketEnvelope::Gamepad {
            controller_id: 1,
            buttons: 0x1000,
            left_trigger: 1,
            right_trigger: 2,
            left_stick_x: 3,
            left_stick_y: 4,
            right_stick_x: 5,
            right_stick_y: 6,
            bitmap: 1,
            use_partially_reliable: true,
            timestamp_us: 99,
        });
        assert_eq!(packet[9], 0x26);
        assert_eq!(packet[10], 1);
        assert_eq!(packet[13], 0x21);
    }
}
