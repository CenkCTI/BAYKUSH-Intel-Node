# NODE-6.2 MRT decoder admission — BGPKIT Parser

Status: **PINNED FOR NODE-6.2**

- Library: `bgpkit-parser`
- Version: `0.18.0`
- Upstream tag: `v0.18.0`
- Upstream tag commit: `c39e39037ccf44de2848e9f48ba82d418d745743`
- License: MIT
- Minimum Rust: 1.87.0
- BAYKUSH wrapper contract: `NODE6_2_MRT_DECODER_V1`

## Selection rationale

RIPE's MRT documentation lists BGPKIT and CAIDA BGPStream among established MRT parser options. NODE-6.2 requires message-level semantics: a physical BGP UPDATE must be counted once even when it contains several prefixes. BGPKIT 0.18.0 exposes `MrtUpdate::Bgp4MpUpdate` through its update iterator, preserving exactly that boundary while still exposing standard and MP_REACH/MP_UNREACH prefix sets. The wrapper therefore does not use the element iterator for update counts.

CAIDA libBGPStream remains the reference/parity decoder for real-fixture acceptance. It is not a second upstream data source and its output is never combined as corroboration.

## Security boundary

`baykush-mrt-decoder` is intentionally narrow:
- the parser library is pinned exactly;
- the wrapper accepts one existing absolute local path and rejects URI-like input;
- fetch/network access is owned by the Node recovery fetcher, not the decoder contract;
- only RIPE UPDATE artifacts are accepted; table-dump/RIB output is rejected for NODE-6.2;
- parse errors fail the process rather than silently producing COMPLETE recovery;
- Node launches the binary with a fixed executable path/argv and `shell: false`;
- runtime binary SHA-256 is captured for every decoder run.

A Cargo lockfile and container digest are release-artifact controls: production release automation must preserve them alongside the recorded runtime binary SHA. Dependency upgrades require a new decoder admission revision and fixture parity run.

## External references

- RIPE RIS MRT format/name/cadence: `https://ris.ripe.net/docs/mrt/`
- BGPKIT Parser upstream: `https://github.com/bgpkit/bgpkit-parser/tree/v0.18.0`
- BGPKIT 0.18.0 update iterator example: `https://github.com/bgpkit/bgpkit-parser/blob/v0.18.0/examples/update_messages_iter.rs`
- CAIDA BGPStream: `https://github.com/CAIDA/libbgpstream`
