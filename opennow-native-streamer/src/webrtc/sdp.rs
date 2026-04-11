use std::collections::{BTreeMap, BTreeSet};

use crate::session::types::MediaConnectionInfo;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceCredentials {
    pub ufrag: String,
    pub pwd: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecPreferenceOptions {
    pub prefer_hevc_profile_id: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NvstParams {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub max_bitrate_kbps: u32,
    pub partial_reliable_threshold_ms: u32,
    pub codec: String,
    pub color_quality: String,
    pub credentials: IceCredentials,
}

pub fn extract_public_ip(host_or_ip: &str) -> Option<String> {
    if host_or_ip.is_empty() {
        return None;
    }
    if host_or_ip.split('.').count() == 4 && host_or_ip.split('.').all(|part| part.parse::<u8>().is_ok()) {
        return Some(host_or_ip.to_string());
    }
    let first = host_or_ip.split('.').next().unwrap_or_default();
    let parts: Vec<_> = first.split('-').collect();
    if parts.len() == 4 && parts.iter().all(|part| part.parse::<u8>().is_ok()) {
        return Some(parts.join("."));
    }
    None
}

pub fn fix_server_ip(sdp: &str, server_ip: &str) -> String {
    let Some(ip) = extract_public_ip(server_ip) else { return sdp.to_string() };
    let fixed = sdp.replace("c=IN IP4 0.0.0.0", &format!("c=IN IP4 {ip}"));
    fixed.replace(" 0.0.0.0 ", &format!(" {ip} "))
}

pub fn extract_ice_credentials(sdp: &str) -> IceCredentials {
    let mut creds = IceCredentials { ufrag: String::new(), pwd: String::new(), fingerprint: String::new() };
    for line in sdp.lines() {
        if let Some(value) = line.strip_prefix("a=ice-ufrag:") {
            creds.ufrag = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("a=ice-pwd:") {
            creds.pwd = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("a=fingerprint:sha-256 ") {
            creds.fingerprint = value.trim().to_string();
        }
    }
    creds
}

pub fn extract_ice_ufrag_from_offer(sdp: &str) -> String {
    extract_ice_credentials(sdp).ufrag
}

pub fn parse_partial_reliable_threshold_ms(sdp: &str) -> Option<u32> {
    sdp.lines()
        .find_map(|line| line.strip_prefix("a=ri.partialReliableThresholdMs:"))
        .and_then(|value| value.trim().parse::<u32>().ok())
        .map(|value| value.clamp(1, 5000))
}

pub fn prefer_codec(sdp: &str, codec: &str, options: &CodecPreferenceOptions) -> String {
    let lines: Vec<String> = sdp.lines().map(|line| line.to_string()).collect();
    let mut in_video = false;
    let mut codec_by_pt = BTreeMap::<String, String>::new();
    let mut payloads_by_codec = BTreeMap::<String, Vec<String>>::new();
    let mut fmtp_by_pt = BTreeMap::<String, String>::new();
    let mut rtx_apt = BTreeMap::<String, String>::new();

    for line in &lines {
        if line.starts_with("m=video") {
            in_video = true;
            continue;
        }
        if line.starts_with("m=") && in_video {
            in_video = false;
        }
        if !in_video {
            continue;
        }
        if let Some(rest) = line.strip_prefix("a=rtpmap:") {
            let mut parts = rest.split_whitespace();
            let pt = parts.next().unwrap_or_default().to_string();
            let codec_name = parts
                .next()
                .unwrap_or_default()
                .split('/')
                .next()
                .unwrap_or_default()
                .to_uppercase()
                .replace("HEVC", "H265");
            if !pt.is_empty() {
                codec_by_pt.insert(pt.clone(), codec_name.clone());
                payloads_by_codec.entry(codec_name).or_default().push(pt);
            }
        }
        if let Some(rest) = line.strip_prefix("a=fmtp:") {
            let mut parts = rest.splitn(2, ' ');
            let pt = parts.next().unwrap_or_default().to_string();
            let params = parts.next().unwrap_or_default().to_string();
            if !pt.is_empty() {
                if let Some(apt) = params.split(';').find_map(|entry| entry.trim().strip_prefix("apt=")) {
                    rtx_apt.insert(pt.clone(), apt.trim().to_string());
                }
                fmtp_by_pt.insert(pt, params);
            }
        }
    }

    let mut preferred = payloads_by_codec.get(&codec.to_uppercase()).cloned().unwrap_or_default();
    if codec.eq_ignore_ascii_case("H265") {
        if let Some(profile) = options.prefer_hevc_profile_id {
            preferred.sort_by_key(|pt| {
                let fmtp = fmtp_by_pt.get(pt).cloned().unwrap_or_default();
                if fmtp.contains(&format!("profile-id={profile}")) { 0 } else if fmtp.contains("profile-id=") { 2 } else { 1 }
            });
        }
    }
    if preferred.is_empty() {
        return sdp.to_string();
    }
    let preferred_set: BTreeSet<_> = preferred.iter().cloned().collect();
    let mut allowed: BTreeSet<String> = preferred.iter().cloned().collect();
    for (rtx_pt, apt) in &rtx_apt {
        if preferred_set.contains(apt) && codec_by_pt.get(rtx_pt).map(|v| v == "RTX").unwrap_or(false) {
            allowed.insert(rtx_pt.clone());
        }
    }

    let mut out = Vec::new();
    in_video = false;
    for line in lines {
        if line.starts_with("m=video") {
            in_video = true;
            let parts: Vec<_> = line.split_whitespace().collect();
            let mut reordered = Vec::new();
            for pt in &preferred {
                if parts[3..].contains(&pt.as_str()) {
                    reordered.push(pt.clone());
                }
            }
            for pt in &parts[3..] {
                if allowed.contains(*pt) && !reordered.iter().any(|entry| entry == pt) {
                    reordered.push((*pt).to_string());
                }
            }
            if reordered.is_empty() {
                out.push(line);
            } else {
                out.push(format!("{} {} {} {}", parts[0], parts[1], parts[2], reordered.join(" ")));
            }
            continue;
        }
        if line.starts_with("m=") && in_video {
            in_video = false;
        }
        if in_video && (line.starts_with("a=rtpmap:") || line.starts_with("a=fmtp:") || line.starts_with("a=rtcp-fb:")) {
            let pt = line.split(':').nth(1).unwrap_or_default().split_whitespace().next().unwrap_or_default();
            if !allowed.contains(pt) {
                continue;
            }
        }
        out.push(line);
    }
    normalize_sdp_line_endings(&out.join("\n"))
}

pub fn rewrite_h265_tier_flag(sdp: &str, tier_flag: u8) -> String {
    normalize_sdp_line_endings(&sdp.replace("tier-flag=1", &format!("tier-flag={tier_flag}")))
}

pub fn rewrite_h265_level_id_by_profile(sdp: &str, max_level_by_profile: &BTreeMap<u8, u32>) -> String {
    let mut out = Vec::new();
    for line in sdp.lines() {
        if line.starts_with("a=fmtp:") && line.contains("profile-id=") && line.contains("level-id=") {
            let profile = line
                .split(';')
                .find_map(|part| part.trim().split_whitespace().last().and_then(|value| value.strip_prefix("profile-id=")).or_else(|| part.trim().strip_prefix("profile-id=")))
                .and_then(|value| value.parse::<u8>().ok());
            let level = line
                .split(';')
                .find_map(|part| part.trim().split_whitespace().last().and_then(|value| value.strip_prefix("level-id=")).or_else(|| part.trim().strip_prefix("level-id=")))
                .and_then(|value| value.parse::<u32>().ok());
            if let (Some(profile_id), Some(level)) = (profile, level) {
                if let Some(max) = max_level_by_profile.get(&profile_id) {
                    if level > *max {
                        out.push(line.replacen(&format!("level-id={level}"), &format!("level-id={max}"), 1));
                        continue;
                    }
                }
            }
        }
        out.push(line.to_string());
    }
    normalize_sdp_line_endings(&out.join("\n"))
}

pub fn munge_answer_sdp(sdp: &str, max_bitrate_kbps: u32) -> String {
    let mut out = Vec::new();
    let lines: Vec<_> = sdp.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        let mut owned = (*line).to_string();
        if owned.starts_with("a=fmtp:") && owned.contains("minptime=") && !owned.contains("stereo=1") {
            owned.push_str(";stereo=1");
        }
        out.push(owned);
        if line.starts_with("m=video") || line.starts_with("m=audio") {
            let next = lines.get(idx + 1).copied().unwrap_or_default();
            if !next.starts_with("b=") {
                let bitrate = if line.starts_with("m=video") { max_bitrate_kbps } else { 128 };
                out.push(format!("b=AS:{bitrate}"));
            }
        }
    }
    normalize_sdp_line_endings(&out.join("\n"))
}

pub fn build_nvst_sdp(params: &NvstParams) -> String {
    let min_bitrate = (params.max_bitrate_kbps as f32 * 0.35).floor().max(5000.0) as u32;
    let initial_bitrate = (params.max_bitrate_kbps as f32 * 0.7).floor().max(min_bitrate as f32) as u32;
    let bit_depth = if params.color_quality.starts_with("10bit") { 10 } else { 8 };
    normalize_sdp_line_endings(&[
        "v=0".to_string(),
        "o=SdpTest test_id_13 14 IN IPv4 127.0.0.1".to_string(),
        "s=-".to_string(),
        "t=0 0".to_string(),
        format!("a=general.icePassword:{}", params.credentials.pwd),
        format!("a=general.iceUserNameFragment:{}", params.credentials.ufrag),
        format!("a=general.dtlsFingerprint:{}", params.credentials.fingerprint),
        "m=video 0 RTP/AVP".to_string(),
        "a=msid:fbc-video-0".to_string(),
        format!("a=video.clientViewportWd:{}", params.width),
        format!("a=video.clientViewportHt:{}", params.height),
        format!("a=video.maxFPS:{}", params.fps),
        format!("a=video.initialBitrateKbps:{initial_bitrate}"),
        format!("a=video.initialPeakBitrateKbps:{}", params.max_bitrate_kbps),
        format!("a=vqos.bw.maximumBitrateKbps:{}", params.max_bitrate_kbps),
        format!("a=vqos.bw.minimumBitrateKbps:{min_bitrate}"),
        format!("a=video.bitDepth:{bit_depth}"),
        "m=audio 0 RTP/AVP".to_string(),
        "a=msid:audio".to_string(),
        "m=mic 0 RTP/AVP".to_string(),
        "a=msid:mic".to_string(),
        "a=rtpmap:0 PCMU/8000".to_string(),
        "m=application 0 RTP/AVP".to_string(),
        "a=msid:input_1".to_string(),
        format!("a=ri.partialReliableThresholdMs:{}", params.partial_reliable_threshold_ms),
        String::new(),
    ]
    .join("\n"))
}

pub fn normalize_sdp_line_endings(sdp: &str) -> String {
    let lines: Vec<&str> = sdp.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\r\n");
    out.push_str("\r\n");
    out
}

pub fn build_manual_ice_candidates(media: &Option<MediaConnectionInfo>, server_ufrag: &str) -> Vec<String> {
    let Some(media) = media else { return Vec::new() };
    let Some(raw_ip) = extract_public_ip(&media.ip) else { return Vec::new() };
    if media.port == 0 {
        return Vec::new();
    }
    ["0", "1", "2", "3"]
        .iter()
        .map(|mid| format!("candidate:1 1 udp 2130706431 {raw_ip} {} typ host|{mid}|{server_ufrag}", media.port))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn extracts_public_ip_from_dash_hostname() {
        assert_eq!(extract_public_ip("80-250-97-40.cloudmatchbeta.nvidiagrid.net").as_deref(), Some("80.250.97.40"));
    }

    #[test]
    fn fixes_server_ip_in_offer() {
        let offer = "c=IN IP4 0.0.0.0\na=candidate:1 1 udp 1 0.0.0.0 49000 typ host";
        let fixed = fix_server_ip(offer, "80-250-97-40.cloudmatchbeta.nvidiagrid.net");
        assert!(fixed.contains("c=IN IP4 80.250.97.40"));
        assert!(fixed.contains(" 80.250.97.40 49000 "));
    }

    #[test]
    fn prefers_h264_and_keeps_rtx() {
        let sdp = "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99\na=rtpmap:96 H264/90000\na=rtpmap:97 RTX/90000\na=fmtp:97 apt=96\na=rtpmap:98 H265/90000\na=rtpmap:99 RTX/90000\na=fmtp:99 apt=98\nm=audio 9 UDP/TLS/RTP/SAVPF 111";
        let filtered = prefer_codec(sdp, "H264", &CodecPreferenceOptions { prefer_hevc_profile_id: None });
        assert!(filtered.contains("m=video 9 UDP/TLS/RTP/SAVPF 96 97"));
        assert!(!filtered.contains("98 99"));
    }

    #[test]
    fn munges_answer() {
        let sdp = "m=video 9 UDP/TLS/RTP/SAVPF 96\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=fmtp:111 minptime=10;useinbandfec=1";
        let munged = munge_answer_sdp(sdp, 50000);
        assert!(munged.contains("b=AS:50000"));
        assert!(munged.contains("b=AS:128"));
        assert!(munged.contains("stereo=1"));
    }

    #[test]
    fn rewrites_h265_level() {
        let mut max = BTreeMap::new();
        max.insert(1, 120);
        let sdp = "a=fmtp:98 profile-id=1;level-id=150;tier-flag=1";
        let rewritten = rewrite_h265_level_id_by_profile(sdp, &max);
        assert!(rewritten.contains("level-id=120"));
    }

    #[test]
    fn builds_nvst_and_manual_ice() {
        let nvst = build_nvst_sdp(&NvstParams { width: 1920, height: 1080, fps: 60, max_bitrate_kbps: 75000, partial_reliable_threshold_ms: 250, codec: "H264".into(), color_quality: "8bit_420".into(), credentials: IceCredentials { ufrag: "abc".into(), pwd: "def".into(), fingerprint: "fp".into() } });
        assert!(nvst.contains("a=video.clientViewportWd:1920"));
        assert!(nvst.contains("a=ri.partialReliableThresholdMs:250"));
        let candidates = build_manual_ice_candidates(&Some(MediaConnectionInfo { ip: "80-250-97-40.cloudmatchbeta.nvidiagrid.net".into(), port: 1234 }), "ufrag");
        assert_eq!(candidates.len(), 4);
    }
}
