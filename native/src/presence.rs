use crate::snapshot::Presence;
use crate::Msg;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

/// The New Teams log directory (`%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\...\Logs`), if it exists.
fn logs_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dir = Path::new(&local)
        .join("Packages")
        .join("MSTeams_8wekyb3d8bbwe")
        .join("LocalCache")
        .join("Microsoft")
        .join("MSTeams")
        .join("Logs");
    dir.is_dir().then_some(dir)
}

/// True for a rolling-log file name (`MSTeams_<ts>.log`). Requires a digit right after the prefix so
/// only the timestamped rolling logs match -- their names then sort chronologically, which `newest_log`
/// relies on (a stray `MSTeams_debug.log` would otherwise sort after the digits and be picked as newest).
fn is_log_name(name: &str) -> bool {
    name.starts_with("MSTeams_")
        && name.ends_with(".log")
        && name.as_bytes().get(8).is_some_and(u8::is_ascii_digit)
}

/// The newest rolling log by file name (timestamped names sort chronologically, so this is robust to
/// equal mtimes at a rotation boundary).
fn newest_log(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.file_name())
        .filter(|n| n.to_str().map(is_log_name).unwrap_or(false))
        .max()
        .map(|n| dir.join(n))
}

/// The rolling log immediately preceding `newest` (greatest name strictly less than it), for a
/// one-off seed read when the just-rotated newest file has no presence token yet.
fn previous_log(dir: &Path, newest: &Path) -> Option<PathBuf> {
    let newest_name = newest.file_name()?;
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.file_name())
        .filter(|n| n.to_str().map(is_log_name).unwrap_or(false))
        .filter(|n| n.as_os_str() < newest_name)
        .max()
        .map(|n| dir.join(n))
}

/// Defensive cap on a single read so a seed on an unexpectedly large log can't spike helper memory.
/// Never engages in practice (Teams rolling logs rotate at ~2 MB) nor on small incremental reads.
const MAX_READ: u64 = 8 * 1024 * 1024;

/// Reads bytes `[start, len)` of `path`, returning the lossy text up to the last newline and the new
/// offset (just past that newline). A trailing partial line is left for the next read so a token is
/// never split. If the span exceeds `MAX_READ` (only possible on a seed of a huge file) it reads just
/// the last `MAX_READ` bytes and drops the partial leading line. Returns `("", start)` when there is
/// nothing complete to read.
fn read_appended(path: &Path, start: u64, len: u64) -> Option<(String, u64)> {
    if len <= start {
        return Some((String::new(), start));
    }
    let read_start = start.max(len.saturating_sub(MAX_READ));
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(read_start)).ok()?;
    let mut buf = vec![0u8; (len - read_start) as usize];
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    // When the read was capped past the caller's offset, skip the (partial) first line.
    let scan_start = if read_start > start {
        buf.iter().position(|&b| b == b'\n').map_or(read, |i| i + 1)
    } else {
        0
    };
    match buf[scan_start..].iter().rposition(|&b| b == b'\n') {
        Some(rel) => {
            let nl = scan_start + rel;
            Some((
                String::from_utf8_lossy(&buf[scan_start..=nl]).into_owned(),
                read_start + nl as u64 + 1,
            ))
        }
        None => Some((String::new(), start)),
    }
}

/// Maps a New Teams availability token to a `Presence`; unrecognised tokens return `None` and are
/// never echoed. Idle variants collapse to their base state.
fn map_token(token: &str) -> Option<Presence> {
    Some(match token {
        "Available" | "AvailableIdle" => Presence::Available,
        "Busy" | "BusyIdle" => Presence::Busy,
        "DoNotDisturb" => Presence::DoNotDisturb,
        "BeRightBack" => Presence::BeRightBack,
        "Away" => Presence::Away,
        "Offline" => Presence::Offline,
        "PresenceUnknown" => Presence::Unknown,
        _ => return None,
    })
}

/// Extracts the last self-attributed presence from a log chunk: the newest `UserPresenceAction` line's
/// `availability:` token. Returns only the enum -- no other text is retained, so no PII can escape.
///
/// Assumes `UserPresenceAction` is the signed-in user's own presence (live-verified: it carries only
/// `cloud_context` + `availability`, no account id, and the multi-user `UserDataGlobalState` heartbeat
/// is deliberately not parsed). If a future Teams build emits it for a second identity, last-write-wins
/// could briefly show the wrong status -- still enum-only, never a leak.
fn parse_presence(chunk: &str) -> Option<Presence> {
    chunk
        .lines()
        .filter(|line| line.contains("UserPresenceAction"))
        .filter_map(|line| line.split("availability:").nth(1))
        .filter_map(|rest| {
            rest.split(|c: char| !c.is_ascii_alphanumeric())
                .find(|s| !s.is_empty())
        })
        .filter_map(map_token)
        .next_back()
}

/// Tails the newest Teams log for the signed-in user's presence. Enum-only and newest-file-only; keeps
/// a byte offset so each poll reads only appended bytes.
struct PresenceReader {
    path: Option<PathBuf>,
    offset: u64,
    last: Option<Presence>,
}

impl PresenceReader {
    fn new() -> Self {
        PresenceReader {
            path: None,
            offset: 0,
            last: None,
        }
    }

    /// Forget all state so a re-enable re-seeds from scratch (called while opt-in is off).
    fn reset(&mut self) {
        self.path = None;
        self.offset = 0;
        self.last = None;
    }

    /// One poll. `seed` (first read after enable) permits a one-off fallback to the previous log when
    /// the newest file has no token yet. Returns a presence only when it is new (or on seed).
    fn poll(&mut self, seed: bool) -> Option<Presence> {
        let dir = logs_dir()?;
        let newest = newest_log(&dir)?;
        // A new newest file (first run or rotation): read it from the start (a just-rotated file is small).
        if self.path.as_deref() != Some(newest.as_path()) {
            self.path = Some(newest.clone());
            self.offset = 0;
        }
        let path = self.path.clone()?;
        let len = fs::metadata(&path).ok()?.len();
        // In-place truncation or name reuse: restart from the beginning.
        if len < self.offset {
            self.offset = 0;
        }
        let (chunk, new_offset) = read_appended(&path, self.offset, len)?;
        self.offset = new_offset;
        let mut found = parse_presence(&chunk);
        // Seeding a freshly rotated newest file that has no token yet: consult the previous file once.
        if found.is_none() && seed {
            if let Some(prev) = previous_log(&dir, &newest) {
                if let Ok(meta) = fs::metadata(&prev) {
                    if let Some((prev_chunk, _)) = read_appended(&prev, 0, meta.len()) {
                        found = parse_presence(&prev_chunk);
                    }
                }
            }
        }
        let p = found?;
        if seed || self.last != Some(p) {
            self.last = Some(p);
            Some(p)
        } else {
            None
        }
    }
}

/// Background presence poller: while opt-in is on, tails the log every couple of seconds and pushes a
/// `Msg::Presence` on each change. A presence change emits no UIA event, so this is the only driver;
/// the interval bounds latency. `reseed` (set by the serve loop on every opt-in "on") forces a fresh
/// full re-read even when the reader never observed an intervening "off" -- so a rapid off/on
/// re-toggle can't leave the tile stuck on "unknown". Exits when the serve channel closes (parent gone).
///
/// This path shares the process with meeting-control actuation under `panic = "abort"`, so it must
/// stay panic- and large-alloc-free (all reads are `?`/`.ok()`, indexing is newline-bounded, and
/// `read_appended` caps the span); a panic here would abort the whole helper, not just presence.
pub(crate) fn presence_reader_loop(
    tx: Sender<Msg>,
    enabled: Arc<AtomicBool>,
    reseed: Arc<AtomicBool>,
) {
    let mut reader = PresenceReader::new();
    let mut was_enabled = false;
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if !enabled.load(Ordering::Relaxed) {
            if was_enabled {
                reader.reset();
                was_enabled = false;
                reseed.store(false, Ordering::Relaxed);
            }
            continue;
        }
        // Seed on the first poll after enable, or whenever the serve loop requested a reseed. Reset
        // first so the seed re-reads the whole newest file (re-reporting the current value even if
        // unchanged), which a re-enable without an observed "off" would otherwise miss.
        let seed = !was_enabled || reseed.swap(false, Ordering::Relaxed);
        was_enabled = true;
        if seed {
            reader.reset();
        }
        if let Some(p) = reader.poll(seed) {
            if tx.send(Msg::Presence(p)).is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::now_ms;

    const PRESENCE_LINE: &str = "2026-07-03T04:28:26.543176+10:00 0x000145f4 <INFO> native_modules::UserDataCrossCloudModule: Received Action: UserPresenceAction: {cloud_context: https://teams.microsoft.com, availability: DoNotDisturb}";

    #[test]
    fn map_token_covers_every_observed_availability() {
        assert_eq!(map_token("Available"), Some(Presence::Available));
        assert_eq!(map_token("Busy"), Some(Presence::Busy));
        assert_eq!(map_token("DoNotDisturb"), Some(Presence::DoNotDisturb));
        assert_eq!(map_token("BeRightBack"), Some(Presence::BeRightBack));
        assert_eq!(map_token("Away"), Some(Presence::Away));
        assert_eq!(map_token("Offline"), Some(Presence::Offline));
        assert_eq!(map_token("PresenceUnknown"), Some(Presence::Unknown));
        // Idle variants collapse to their base state (Teams reports these when the machine is idle).
        assert_eq!(map_token("AvailableIdle"), Some(Presence::Available));
        assert_eq!(map_token("BusyIdle"), Some(Presence::Busy));
        // An unrecognised token is dropped (returns None); it is never surfaced as text.
        assert_eq!(map_token("Presenting"), None);
        assert_eq!(map_token(""), None);
    }

    #[test]
    fn parse_presence_reads_the_last_user_presence_action() {
        assert_eq!(parse_presence(PRESENCE_LINE), Some(Presence::DoNotDisturb));
        // The newest change wins when several lines are appended in one read.
        let chunk = format!(
            "{a}\nsome other log line\n{b}\n",
            a = PRESENCE_LINE.replace("DoNotDisturb", "Busy"),
            b = PRESENCE_LINE.replace("DoNotDisturb", "Available"),
        );
        assert_eq!(parse_presence(&chunk), Some(Presence::Available));
    }

    #[test]
    fn parse_presence_ignores_the_multi_user_heartbeat() {
        // The BroadcastGlobalState/UserDataGlobalState heartbeat lists multiple users with unstable
        // slot order and is NOT self-identifying, so only the self-attributed UserPresenceAction line
        // is parsed. This anonymous heartbeat must yield nothing.
        let heartbeat = "... UserDataGlobalState total number of users: 2 { availability: Busy, unread notification count: 1 } { availability: PresenceUnknown, unread notification count: 0 }";
        assert_eq!(parse_presence(heartbeat), None);
    }

    #[test]
    fn parse_presence_extracts_only_the_enum_and_drops_pii() {
        // A realistic buffer: identifiers and free text surround one presence line. The parser must
        // return only the enum -- it returns a `Presence`, so no surrounding text can escape by
        // construction -- and a buffer with PII but no presence line must yield nothing at all.
        let pii = "\
2026-07-03T04:00:00 <INFO> auth: signed in user alice.smith@contoso.com tenant 11111111-2222-3333-4444-555555555555 mri 8:orgid:66666666-7777-8888-9999-000000000000\n\
2026-07-03T04:00:01 <INFO> calendar: event 'Budget review with Bob' join https://teams.microsoft.com/l/meetup-join/xyz\n";
        let with_presence = format!("{pii}{PRESENCE_LINE}\n");
        assert_eq!(parse_presence(&with_presence), Some(Presence::DoNotDisturb));
        // No presence line => nothing extracted, so none of the PII can leak through this path.
        assert_eq!(parse_presence(pii), None);
    }

    #[test]
    fn parse_presence_never_panics_on_arbitrary_input() {
        // Adversarial fragments (partial lines, no newline, non-ASCII, truncated keys) must return
        // None/Some without panicking -- the reader runs under panic=abort and must never crash.
        for bad in [
            "",
            "\n\n\n",
            "UserPresenceAction",
            "UserPresenceAction: availability:",
            "availability: Busy (no UserPresenceAction marker)",
            "UserPresenceAction availability: ☃🎉 émoji ünïcode",
            "UserPresenceAction: {availability:",
            &"UserPresenceAction: {availability: ".repeat(1000),
            "\u{0}\u{1}\u{2} UserPresenceAction availability: Busy",
        ] {
            let _ = parse_presence(bad);
        }
        // The one well-formed adversarial line still resolves.
        assert_eq!(
            parse_presence("UserPresenceAction availability: Busy"),
            Some(Presence::Busy)
        );
    }

    #[test]
    fn read_appended_advances_to_last_newline_and_holds_partial_lines() {
        use std::io::Write as _;
        let mut path = std::env::temp_dir();
        path.push(format!(
            "teamdeck_ra_{}_{}.log",
            std::process::id(),
            now_ms()
        ));

        // Two complete lines plus a trailing partial (no newline).
        fs::write(
            &path,
            b"line one\nUserPresenceAction availability: Busy\npartial",
        )
        .unwrap();
        let len = fs::metadata(&path).unwrap().len();
        let (chunk, off) = read_appended(&path, 0, len).unwrap();
        assert_eq!(parse_presence(&chunk), Some(Presence::Busy));
        assert!(
            !chunk.contains("partial"),
            "a trailing partial line is held back"
        );

        // No new complete line yet: nothing to read, offset unchanged.
        let (chunk2, off2) = read_appended(&path, off, len).unwrap();
        assert_eq!(chunk2, "");
        assert_eq!(off2, off);

        // Complete the partial line and append a new change; only the new bytes are read.
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b" tail\nUserPresenceAction availability: Available\n")
            .unwrap();
        let len3 = fs::metadata(&path).unwrap().len();
        let (chunk3, _off3) = read_appended(&path, off, len3).unwrap();
        assert_eq!(parse_presence(&chunk3), Some(Presence::Available));
        assert!(
            !chunk3.contains("Busy"),
            "only newly appended bytes are read"
        );

        let _ = fs::remove_file(&path);
    }
}
