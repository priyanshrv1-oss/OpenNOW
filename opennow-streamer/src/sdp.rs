pub fn extract_public_ip(host_or_ip: &str) -> Option<String> {
    if host_or_ip.is_empty() {
        return None;
    }
    if host_or_ip.split('.').count() == 4 && host_or_ip.split('.').all(|p| p.parse::<u8>().is_ok()) {
        return Some(host_or_ip.to_string());
    }
    let first = host_or_ip.split('.').next().unwrap_or_default();
    let parts: Vec<_> = first.split('-').collect();
    if parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok()) {
        return Some(parts.join("."));
    }
    None
}

pub fn fix_server_ip(sdp: &str, server_ip: &str) -> String {
    let Some(ip) = extract_public_ip(server_ip) else {
        return sdp.to_string();
    };
    let fixed = sdp.replace("c=IN IP4 0.0.0.0", &format!("c=IN IP4 {ip}"));
    fixed
        .lines()
        .map(|line| {
            if line.starts_with("a=candidate:") && line.contains(" 0.0.0.0 ") {
                line.replacen(" 0.0.0.0 ", &format!(" {ip} "), 1)
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

pub fn parse_partial_reliable_threshold_ms(sdp: &str) -> Option<u16> {
    sdp.lines()
        .find_map(|line| line.trim().strip_prefix("a=ri.partialReliableThresholdMs:"))
        .and_then(|value| value.trim().parse::<u16>().ok())
}

pub fn extract_ice_ufrag_from_offer(sdp: &str) -> String {
    sdp.lines()
        .find_map(|line| line.trim().strip_prefix("a=ice-ufrag:"))
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

pub fn munge_answer_sdp(sdp: &str, max_bitrate_kbps: u32) -> String {
    let mut out = Vec::new();
    let mut current_media = String::new();
    let mut inserted_bitrate = false;
    for line in sdp.lines() {
        if line.starts_with("m=") {
            current_media = line.to_string();
            inserted_bitrate = false;
            out.push(line.to_string());
            continue;
        }
        if !inserted_bitrate && (line.starts_with("c=") || line.starts_with("a=mid:")) {
            out.push(line.to_string());
            if current_media.starts_with("m=video") {
                out.push(format!("b=AS:{max_bitrate_kbps}"));
                inserted_bitrate = true;
            }
            continue;
        }
        if line.starts_with("a=fmtp:") && current_media.starts_with("m=audio") && !line.contains("stereo=1") {
            out.push(format!("{line};stereo=1;sprop-stereo=1"));
            continue;
        }
        out.push(line.to_string());
    }
    out.join("\r\n")
}

pub fn prefer_codec(sdp: &str, codec: &str) -> String {
    let target = codec.to_uppercase();
    let mut allowed_pts = Vec::<String>::new();
    let mut rtx_by_pt = Vec::<(String, String)>::new();
    let mut in_video = false;
    for line in sdp.lines() {
        if line.starts_with("m=video") {
            in_video = true;
            continue;
        }
        if line.starts_with("m=") && in_video {
            in_video = false;
        }
        if !in_video { continue; }
        if let Some(rest) = line.strip_prefix("a=rtpmap:") {
            let mut parts = rest.split_whitespace();
            let pt = parts.next().unwrap_or_default();
            let codec_name = parts.next().unwrap_or_default().split('/').next().unwrap_or_default().to_uppercase();
            let normalized = if codec_name == "HEVC" { "H265".to_string() } else { codec_name };
            if normalized == target {
                allowed_pts.push(pt.to_string());
            }
        }
    }
    in_video = false;
    for line in sdp.lines() {
        if line.starts_with("m=video") {
            in_video = true;
            continue;
        }
        if line.starts_with("m=") && in_video { in_video = false; }
        if !in_video { continue; }
        if let Some(rest) = line.strip_prefix("a=fmtp:") {
            let mut parts = rest.split_whitespace();
            let pt = parts.next().unwrap_or_default().to_string();
            let params = parts.next().unwrap_or_default();
            if let Some(apt) = params.split(';').find_map(|entry| entry.trim().strip_prefix("apt=")) {
                if allowed_pts.iter().any(|allowed| allowed == apt) {
                    rtx_by_pt.push((pt, apt.to_string()));
                }
            }
        }
    }
    let mut keep = allowed_pts.clone();
    for (pt, _) in &rtx_by_pt {
        keep.push(pt.clone());
    }
    let mut result = Vec::new();
    in_video = false;
    for line in sdp.lines() {
        if line.starts_with("m=video") {
            in_video = true;
            let mut parts: Vec<_> = line.split_whitespace().map(ToString::to_string).collect();
            if parts.len() > 3 {
                parts.truncate(3);
                parts.extend(keep.iter().cloned());
            }
            result.push(parts.join(" "));
            continue;
        }
        if line.starts_with("m=") && in_video { in_video = false; }
        if in_video && (line.starts_with("a=rtpmap:") || line.starts_with("a=rtcp-fb:") || line.starts_with("a=fmtp:")) {
            let pt = line.split(':').nth(1).unwrap_or_default().split_whitespace().next().unwrap_or_default();
            if !keep.iter().any(|keep_pt| keep_pt == pt) {
                continue;
            }
        }
        result.push(line.to_string());
    }
    result.join("\r\n")
}

pub fn rewrite_h265_offer(sdp: &str) -> String {
    sdp.lines()
        .map(|line| {
            if line.starts_with("a=fmtp:") {
                line.replace("tier-flag=1", "tier-flag=0")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

pub fn build_nvst_sdp(
    resolution: &str,
    fps: u16,
    max_bitrate_mbps: u16,
    codec: &str,
    color_quality: &str,
    enable_l4s: bool,
    partial_reliable_threshold_ms: u16,
) -> String {
    let mut parts = resolution.split('x');
    let width = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1920);
    let height = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1080);
    let bit_depth = if color_quality.starts_with("10bit") { 10 } else { 8 };
    let chroma = if color_quality.ends_with("444") { 444 } else { 420 };
    format!(
        "v=0\r\no=OpenNOW 0 0 IN IP4 127.0.0.1\r\ns=OpenNOW NVST\r\nt=0 0\r\na=x-nv-general.featureFlags:0\r\na=x-nv-video[0].clientViewportWd:{width}\r\na=x-nv-video[0].clientViewportHt:{height}\r\na=video.codec:{}\r\na=video.maxFPS:{}\r\na=video.bitDepth:{}\r\na=video.chroma:{}\r\na=bwe.maxBitrateKbps:{}\r\na=vqos.l4s:{}\r\na=ri.partialReliableThresholdMs:{}\r\nm=video 9 RTP/AVP 96\r\na=recvonly\r\nm=audio 9 RTP/AVP 111\r\na=recvonly\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sendrecv\r\n",
        codec.to_uppercase(),
        fps,
        bit_depth,
        chroma,
        u32::from(max_bitrate_mbps) * 1000,
        if enable_l4s { 1 } else { 0 },
        partial_reliable_threshold_ms,
    )
}
