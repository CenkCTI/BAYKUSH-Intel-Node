use bgpkit_parser::models::{AsPathSegment, AttributeValue, Bgp4MpEnum, BgpMessage, MrtMessage};
use bgpkit_parser::{BgpkitParser, ParserError};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use std::env;
use std::io::{self, Write};
use std::path::Path;
use std::process;

const CONTRACT: &str = "NODE6_2_MRT_DECODER_V1";
const SUMMARY_CONTRACT: &str = "NODE6_2_MRT_DECODER_SUMMARY_V1";
const DECODER_VERSION: &str = "baykush-mrt-decoder/0.1.0+bgpkit-parser-0.18.0";

#[derive(Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SegmentKind {
    AsSequence,
    AsSet,
    ConfedSequence,
    ConfedSet,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathSegment {
    kind: SegmentKind,
    asns: Vec<u32>,
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecoderSummary {
    schema_version: &'static str,
    records_read: u64,
    updates_decoded: u64,
    state_change_records: u64,
    ignored_valid_records: u64,
    records_rejected: u64,
}

fn timestamp(seconds: u32, microseconds: Option<u32>) -> Result<String, String> {
    let micros = microseconds.unwrap_or(0);
    if micros >= 1_000_000 {
        return Err("invalid MRT microsecond timestamp".into());
    }
    DateTime::<Utc>::from_timestamp(i64::from(seconds), micros * 1_000)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Nanos, true))
        .ok_or_else(|| "MRT timestamp outside supported range".into())
}

fn path_segments(path: Option<&bgpkit_parser::models::AsPath>) -> Vec<PathSegment> {
    path.map(|value| {
        value
            .segments
            .iter()
            .map(|segment| {
                let (kind, values) = match segment {
                    AsPathSegment::AsSequence(values) => (SegmentKind::AsSequence, values),
                    AsPathSegment::AsSet(values) => (SegmentKind::AsSet, values),
                    AsPathSegment::ConfedSequence(values) => (SegmentKind::ConfedSequence, values),
                    AsPathSegment::ConfedSet(values) => (SegmentKind::ConfedSet, values),
                };
                PathSegment {
                    kind,
                    asns: values.iter().map(|asn| u32::from(*asn)).collect(),
                }
            })
            .collect()
    })
    .unwrap_or_default()
}

fn write_json_line<T: Serialize>(out: &mut impl Write, value: &T) {
    if serde_json::to_writer(&mut *out, value).is_err() || writeln!(out).is_err() {
        eprintln!("decoder stdout write failed");
        process::exit(74);
    }
}

fn usage() -> ! {
    eprintln!("usage: baykush-mrt-decoder <absolute-local-mrt-path> | --version | --contract");
    process::exit(64)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() == 2 && args[1] == "--version" {
        println!("{DECODER_VERSION}");
        return;
    }
    if args.len() == 2 && args[1] == "--contract" {
        println!("{CONTRACT}");
        return;
    }
    if args.len() != 2 {
        usage();
    }

    let input = &args[1];
    if input.contains("://") {
        eprintln!("remote decoder input is forbidden");
        process::exit(65);
    }
    let path = Path::new(input);
    if !path.is_absolute() || !path.is_file() {
        eprintln!("decoder input must be an existing absolute local file");
        process::exit(66);
    }

    let mut parser = match BgpkitParser::new(input) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("parser initialization failed: {error:?}");
            process::exit(70);
        }
    };

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut records_read = 0_u64;
    let mut updates_decoded = 0_u64;
    let mut state_change_records = 0_u64;
    let mut ignored_valid_records = 0_u64;

    loop {
        let mrt_record = match parser.next_record() {
            Ok(value) => value,
            Err(error) if matches!(error.error, ParserError::EofExpected) => break,
            Err(error) => {
                eprintln!("MRT parse failure at physical record index {records_read}: {error:?}");
                process::exit(72);
            }
        };
        let record_index = records_read;
        records_read += 1;

        let observed_at = match timestamp(
            mrt_record.common_header.timestamp,
            mrt_record.common_header.microsecond_timestamp,
        ) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("{error}");
                process::exit(73);
            }
        };

        let message = match mrt_record.message {
            MrtMessage::Bgp4Mp(Bgp4MpEnum::StateChange(_)) => {
                state_change_records += 1;
                ignored_valid_records += 1;
                continue;
            }
            MrtMessage::Bgp4Mp(Bgp4MpEnum::Message(message)) => message,
            MrtMessage::TableDumpV2Message(_) | MrtMessage::TableDumpMessage(_) => {
                eprintln!("RIB/table-dump record encountered in NODE-6.2 update-only decoder");
                process::exit(71);
            }
        };

        let update = match message.bgp_message {
            BgpMessage::Update(update) => update,
            BgpMessage::Open(_) | BgpMessage::Notification(_) | BgpMessage::KeepAlive => {
                ignored_valid_records += 1;
                continue;
            }
        };

        let mut announced: Vec<String> = update
            .announced_prefixes
            .iter()
            .map(ToString::to_string)
            .collect();
        let mut withdrawn: Vec<String> = update
            .withdrawn_prefixes
            .iter()
            .map(ToString::to_string)
            .collect();
        for attribute in update.attributes.iter() {
            match attribute {
                AttributeValue::MpReachNlri(nlri) => {
                    announced.extend(nlri.prefixes.iter().map(ToString::to_string));
                }
                AttributeValue::MpUnreachNlri(nlri) => {
                    withdrawn.extend(nlri.prefixes.iter().map(ToString::to_string));
                }
                _ => {}
            }
        }
        announced.sort();
        announced.dedup();
        withdrawn.sort();
        withdrawn.dedup();

        let record = DecoderRecord {
            schema_version: CONTRACT,
            record_index,
            record_type: "BGP4MP",
            record_subtype: "BGP4MP_UPDATE",
            source_observed_at: observed_at,
            peer_ip: message.peer_ip.to_string(),
            peer_asn: u32::from(message.peer_asn),
            announced_prefixes: announced,
            withdrawn_prefixes: withdrawn,
            as_path_segments: path_segments(update.attributes.as_path()),
        };
        write_json_line(&mut out, &record);
        updates_decoded += 1;
    }

    let summary = DecoderSummary {
        schema_version: SUMMARY_CONTRACT,
        records_read,
        updates_decoded,
        state_change_records,
        ignored_valid_records,
        records_rejected: 0,
    };
    write_json_line(&mut out, &summary);
}
