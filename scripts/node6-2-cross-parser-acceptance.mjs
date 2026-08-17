import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const fixtureUrl = "https://data.ris.ripe.net/rrc00/2024.01/updates.20240101.0000.gz";
const expectedSha = "25c7c8cdf797dcf03b3f6a40b5b8264827bedc2ed0d99b33204ce4cd34954313";
const caidaImage = "caida/bgpstream:2.1.0";
const caidaDigest = "sha256:85ba51ac62caf406349a533a659d792c5e7df3aef239543c1ea4b5a1840c0288";
const baykushImage = process.env.NODE6_2_BAYKUSH_IMAGE ?? "baykush-intelligence-node:node6-2-acceptance";
const work = path.resolve(process.env.NODE6_2_ACCEPTANCE_DIR ?? "/tmp/node6-2-acceptance");
const fixture = path.join(work, "updates.20240101.0000.gz");
const baykushOutput = path.join(work, "baykush.jsonl");
const bgpreaderOutput = path.join(work, "bgpreader.txt");
const evidencePath = path.resolve("docs/acceptance/NODE_6_2_CROSS_PARSER_ACCEPTANCE.json");

function command(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, stdio: options.stdio ?? ["ignore", "pipe", "inherit"] }).trim();
}
function shaFile(file) {
  const hash = createHash("sha256"); hash.update(readFileSync(file)); return hash.digest("hex");
}
function setHash(values) { return createHash("sha256").update([...values].sort().join("\n")).digest("hex"); }
function family(prefix) { return prefix.includes(":") ? 6 : 4; }
function emptyMetrics() {
  return { announcements: 0, withdrawals: 0, ipv4Announcements: 0, ipv6Announcements: 0,
    ipv4Withdrawals: 0, ipv6Withdrawals: 0, announced: new Set(), withdrawn: new Set(),
    peerAsns: new Set(), peerIps: new Set(), minTimestamp: null, maxTimestamp: null, stateEvents: 0 };
}
function timestamp(metrics, value) {
  if (metrics.minTimestamp === null || value < metrics.minTimestamp) metrics.minTimestamp = value;
  if (metrics.maxTimestamp === null || value > metrics.maxTimestamp) metrics.maxTimestamp = value;
}
async function parseBaykush() {
  const metrics = emptyMetrics(); let summary;
  const lines = createInterface({ input: createReadStream(baykushOutput), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = JSON.parse(line);
    if (row.schemaVersion === "NODE6_2_MRT_DECODER_SUMMARY_V1") { summary = row; continue; }
    timestamp(metrics, Date.parse(row.sourceObservedAt) / 1000);
    if (row.announcedPrefixes.length > 0 || row.withdrawnPrefixes.length > 0) {
      metrics.peerAsns.add(String(row.peerAsn)); metrics.peerIps.add(row.peerIp);
    }
    for (const prefix of row.announcedPrefixes) { metrics.announcements++; metrics.announced.add(prefix); metrics[`ipv${family(prefix)}Announcements`]++; }
    for (const prefix of row.withdrawnPrefixes) { metrics.withdrawals++; metrics.withdrawn.add(prefix); metrics[`ipv${family(prefix)}Withdrawals`]++; }
  }
  if (!summary) throw new Error("BAYKUSH decoder summary missing");
  metrics.stateEvents = summary.stateChangeRecords;
  return { metrics, summary };
}
async function parseBgpreader() {
  const metrics = emptyMetrics(); const types = {};
  const lines = createInterface({ input: createReadStream(bgpreaderOutput), crlfDelay: Infinity });
  for await (const line of lines) {
    const fields = line.split("|"); const type = fields[1]; types[type] = (types[type] ?? 0) + 1;
    const observed = Number(fields[2]); if (Number.isFinite(observed)) timestamp(metrics, observed);
    const prefix = fields[9];
    if ((type === "A" || type === "W") && prefix) {
      if (fields[7]) metrics.peerAsns.add(fields[7]); if (fields[8]) metrics.peerIps.add(fields[8]);
    }
    if (type === "A" && prefix) { metrics.announcements++; metrics.announced.add(prefix); metrics[`ipv${family(prefix)}Announcements`]++; }
    else if (type === "W" && prefix) { metrics.withdrawals++; metrics.withdrawn.add(prefix); metrics[`ipv${family(prefix)}Withdrawals`]++; }
    else if (type === "S") metrics.stateEvents++;
  }
  return { metrics, types };
}
function publicMetrics(metrics) {
  return {
    announcementPrefixEventCount: metrics.announcements, withdrawalPrefixEventCount: metrics.withdrawals,
    uniqueAnnouncedPrefixes: { count: metrics.announced.size, sortedSetSha256: setHash(metrics.announced) },
    uniqueWithdrawnPrefixes: { count: metrics.withdrawn.size, sortedSetSha256: setHash(metrics.withdrawn) },
    peerAsns: { count: metrics.peerAsns.size, sortedSetSha256: setHash(metrics.peerAsns) },
    peerIps: { count: metrics.peerIps.size, sortedSetSha256: setHash(metrics.peerIps) },
    timestampMinimum: new Date(metrics.minTimestamp * 1000).toISOString(),
    timestampMaximum: new Date(metrics.maxTimestamp * 1000).toISOString(),
    ipv4AnnouncementCount: metrics.ipv4Announcements, ipv6AnnouncementCount: metrics.ipv6Announcements,
    ipv4WithdrawalCount: metrics.ipv4Withdrawals, ipv6WithdrawalCount: metrics.ipv6Withdrawals,
    stateEventCount: metrics.stateEvents,
  };
}

mkdirSync(work, { recursive: true });
if (!existsSync(fixture)) command("curl", ["--fail", "--show-error", "--silent", "--location", "--proto", "=https", "--tlsv1.2", "--max-time", "240", "--output", fixture, fixtureUrl]);
if (shaFile(fixture) !== expectedSha) throw new Error("Official RIPE fixture SHA-256 mismatch");
command("gzip", ["-t", fixture]);
if (!existsSync(baykushOutput)) writeFileSync(baykushOutput, `${command("docker", ["run", "--rm", "-v", `${work}:/fixture:ro`, baykushImage, "/usr/local/bin/baykush-mrt-decoder", "/fixture/updates.20240101.0000.gz"])}\n`);
if (!existsSync(bgpreaderOutput)) writeFileSync(bgpreaderOutput, `${command("docker", ["run", "--rm", "-v", `${work}:/fixture:ro`, caidaImage, "bgpreader", "-d", "singlefile", "-o", "upd-file=/fixture/updates.20240101.0000.gz", "-w", "1704067200,1704067500"])}\n`);
if (!existsSync(baykushOutput) || !existsSync(bgpreaderOutput)) throw new Error("Parser outputs were not retained in the acceptance directory");
const baykush = await parseBaykush(); const caida = await parseBgpreader();
const b = publicMetrics(baykush.metrics); const c = publicMetrics(caida.metrics);
const comparable = ["announcementPrefixEventCount", "withdrawalPrefixEventCount", "uniqueAnnouncedPrefixes", "uniqueWithdrawnPrefixes", "ipv4AnnouncementCount", "ipv6AnnouncementCount", "ipv4WithdrawalCount", "ipv6WithdrawalCount"];
const equality = Object.fromEntries(comparable.map((key) => [key, JSON.stringify(b[key]) === JSON.stringify(c[key])]));
equality.timestampRange = b.timestampMinimum === c.timestampMinimum && b.timestampMaximum === c.timestampMaximum;
equality.peerAsnSet = b.peerAsns.sortedSetSha256 === c.peerAsns.sortedSetSha256;
equality.peerIpSet = b.peerIps.sortedSetSha256 === c.peerIps.sortedSetSha256;
const accepted = baykush.summary.recordsRejected === 0 && Object.values(equality).every(Boolean);
const evidence = {
  schemaVersion: "NODE6_2_CROSS_PARSER_ACCEPTANCE_V1", accepted,
  testedAt: new Date().toISOString(), testedGitCommit: command("git", ["rev-parse", "HEAD"]),
  artifact: { sourceUrl: fixtureUrl, sha256: expectedSha, compressedBytes: statSync(fixture).size, sameArtifactForBothParsers: true },
  baykushDecoder: { wrapperVersion: command("docker", ["run", "--rm", baykushImage, "/usr/local/bin/baykush-mrt-decoder", "--version"]), bgpkitParserVersion: "0.18.0", binarySha256: command("docker", ["run", "--rm", baykushImage, "sha256sum", "/usr/local/bin/baykush-mrt-decoder"]).split(/\s+/)[0], summary: baykush.summary, metrics: b },
  libBGPStream: { version: "2.1.0", bgpreaderVersion: "2.1.0", image: caidaImage, imageDigest: caidaDigest, interface: "singlefile", elementTypes: caida.types, metrics: c },
  comparisons: equality,
  differences: accepted ? [] : Object.entries(equality).filter(([, equal]) => !equal).map(([field]) => ({ field, status: "MISMATCH" })),
  explanation: "libBGPStream emits prefix/state elements, while BAYKUSH updatesDecoded counts physical BGP UPDATE messages; those totals are NOT_COMPARABLE and are not asserted equal. Peer sets are compared only across A/W prefix-bearing messages because bgpreader also emits state-event peers and emits no element for zero-prefix UPDATE messages.",
  commands: { baykush: "docker run --rm -v <acceptance-dir>:/fixture:ro <baykush-image> baykush-mrt-decoder /fixture/updates.20240101.0000.gz", libBGPStream: "docker run --rm -v <acceptance-dir>:/fixture:ro caida/bgpstream:2.1.0 bgpreader -d singlefile -o upd-file=/fixture/updates.20240101.0000.gz -w 1704067200,1704067500" },
};
mkdirSync(path.dirname(evidencePath), { recursive: true }); writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ accepted, evidencePath, comparisons: equality }, null, 2));
if (!accepted) process.exitCode = 1;
