use bgpkit_parser::models::{AsPathSegment, AttributeValue};
use bgpkit_parser::{BgpkitParser, MrtUpdate};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::env;
use std::io::{self, Write};
use std::path::Path;
use std::process;

const CONTRACT: &str = "NODE6_2_MRT_DECODER_V1";
const DECODER_VERSION: &str = "baykush-mrt-decoder/0.1.0+bgpkit-parser-0.18.0";

#[derive(Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SegmentKind { AsSequence, AsSet, ConfedSequence, ConfedSet }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathSegment { kind: SegmentKind, asns: Vec<u32> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecoderRecord {
    schema_version: &'static str,
    record_index: u64,
    record_type: &'static str,
    record_subtype: &'static str,
    source_observed_at: String,
    peer_ip: String,
    peer_asn: u32,
    announced_prefixes: Vec<String>,
    withdrawn_prefixes: Vec<String>,
    as_path_segments: Vec<PathSegment>,
}

fn timestamp(value: f64) -> Result<String, String> {
    if !value.is_finite() || value < 0.0 { return Err("invalid MRT timestamp".into()); }
    let seconds = value.floor() as i64;
    let nanos = ((value - value.floor()) * 1_000_000_000.0).round() as u32;
    DateTime::<Utc>::from_timestamp(seconds, nanos)
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Nanos, true))
        .ok_or_else(|| "MRT timestamp outside supported range".into())
}

fn path_segments(path: Option<&bgpkit_parser::models::AsPath>) -> Vec<PathSegment> {
    path.map(|p| p.segments.iter().map(|segment| {
        let (kind, values) = match segment {
            AsPathSegment::AsSequence(v) => (SegmentKind::AsSequence, v),
            AsPathSegment::AsSet(v) => (SegmentKind::AsSet, v),
            AsPathSegment::ConfedSequence(v) => (SegmentKind::ConfedSequence, v),
            AsPathSegment::ConfedSet(v) => (SegmentKind::ConfedSet, v),
        };
        PathSegment { kind, asns: values.iter().map(|asn| u32::from(*asn)).collect() }
    }).collect()).unwrap_or_default()
}

fn usage() -> ! {
    eprintln!("usage: baykush-mrt-decoder <absolute-local-mrt-path> | --version | --contract");
    process::exit(64)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() == 2 && args[1] == "--version" { println!("{DECODER_VERSION}"); return; }
    if args.len() == 2 && args[1] == "--contract" { println!("{CONTRACT}"); return; }
    if args.len() != 2 { usage(); }
    let input = &args[1];
    if input.contains("://") { eprintln!("remote decoder input is forbidden"); process::exit(65); }
    let path = Path::new(input);
    if !path.is_absolute() || !path.is_file() { eprintln!("decoder input must be an existing absolute local file"); process::exit(66); }

    let parser = match BgpkitParser::new(input) {
        Ok(value) => value,
        Err(error) => { eprintln!("parser initialization failed: {error:?}"); process::exit(70); }
    };

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut record_index = 0_u64;
    for item in parser.into_fallible_update_iter() {
        let update = match item {
            Ok(MrtUpdate::Bgp4MpUpdate(value)) => value,
            Ok(MrtUpdate::TableDumpV2Entry(_)) | Ok(MrtUpdate::TableDumpMessage(_)) => {
                eprintln!("RIB/table-dump record encountered in NODE-6.2 update-only decoder");
                process::exit(71);
            }
            Err(error) => {
                eprintln!("MRT parse failure at projected update index {record_index}: {error:?}");
                process::exit(72);
            }
        };

        let mut announced: Vec<String> = update.message.announced_prefixes.iter().map(ToString::to_string).collect();
        let mut withdrawn: Vec<String> = update.message.withdrawn_prefixes.iter().map(ToString::to_string).collect();
        for attribute in update.message.attributes.iter() {
            match attribute {
                AttributeValue::MpReachNlri(nlri) => announced.extend(nlri.prefixes.iter().map(ToString::to_string)),
                AttributeValue::MpUnreachNlri(nlri) => withdrawn.extend(nlri.prefixes.iter().map(ToString::to_string)),
                _ => {}
            }
        }
        announced.sort(); announced.dedup();
        withdrawn.sort(); withdrawn.dedup();

        let record = DecoderRecord {
            schema_version: CONTRACT,
            record_index,
            record_type: "BGP4MP",
            record_subtype: "BGP4MP_UPDATE",
            source_observed_at: match timestamp(update.timestamp) {
                Ok(value) => value,
                Err(error) => { eprintln!("{error}"); process::exit(73); }
            },
            peer_ip: update.peer_ip.to_string(),
            peer_asn: u32::from(update.peer_asn),
            announced_prefixes: announced,
            withdrawn_prefixes: withdrawn,
            as_path_segments: path_segments(update.message.attributes.as_path()),
        };
        if serde_json::to_writer(&mut out, &record).is_err() || writeln!(&mut out).is_err() {
            eprintln!("decoder stdout write failed"); process::exit(74);
        }
        record_index += 1;
    }
}
