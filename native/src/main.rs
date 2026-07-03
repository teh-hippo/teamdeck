//! TeamDeck native helper.
//!
//! Reads Microsoft Teams meeting state via Windows UI Automation and actuates the meeting controls.
//! Emits the snapshot contract as one JSON object per line on stdout.

use serde::Serialize;
use std::fs;
use std::io::{BufRead, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use uiautomation::events::{
    CustomEventHandlerFn, CustomPropertyChangedEventHandlerFn, UIEventHandler, UIEventType,
    UIPropertyChangedEventHandler,
};
use uiautomation::patterns::{UIExpandCollapsePattern, UILegacyIAccessiblePattern};
use uiautomation::types::{ExpandCollapseState, Handle, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use windows::core::w;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_QWORD};

#[derive(Serialize)]
struct Signal {
    value: Option<bool>,
    available: bool,
    source: String,
}

impl Signal {
    fn unknown() -> Self {
        Signal {
            value: None,
            available: false,
            source: "none".into(),
        }
    }
}

#[derive(Serialize)]
struct Signals {
    mute: Signal,
    camera: Signal,
    hand: Signal,
    sharing: Signal,
}

/// Coarse Teams availability, read language-independently from the New Teams log's `UserPresenceAction`
/// line. `Unknown` covers "not read yet", "opt-in off", "Teams not running" and the log's own
/// `PresenceUnknown` token. Activity variants (Presenting/OutOfOffice/...) are not in the coarse log token.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Presence {
    Available,
    Busy,
    DoNotDisturb,
    BeRightBack,
    Away,
    Offline,
    Unknown,
}

/// The presence field of the snapshot. `source` is one of the fixed strings `teams-log` / `disabled`
/// (the plugin also recognises `none` for an older helper) -- never raw log text -- so no log content
/// can reach the wire via this field.
#[derive(Serialize, Clone)]
struct PresenceState {
    value: Presence,
    known: bool,
    source: String,
}

impl PresenceState {
    /// Opt-in off: the helper reads no log.
    fn disabled() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
            source: "disabled".into(),
        }
    }

    /// Opt-in on but nothing read yet (seeding).
    fn seeking() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
            source: "teams-log".into(),
        }
    }

    /// A value read from the log. `known` is false for `Unknown` so the UI renders "unavailable".
    fn from_value(p: Presence) -> Self {
        PresenceState {
            value: p,
            known: p != Presence::Unknown,
            source: "teams-log".into(),
        }
    }
}

#[derive(Serialize)]
struct WindowInfo {
    pid: u32,
    name: String,
}

/// Snapshot contract: one JSON line per tick. `teamsRunning`/`inMeeting`/`signals`/`presence` drive the plugin; the rest are diagnostic.
#[derive(Serialize)]
struct Snapshot {
    schema: u32,
    ts: u128,
    #[serde(rename = "teamsRunning")]
    teams_running: bool,
    #[serde(rename = "inMeeting")]
    in_meeting: bool,
    window: Option<WindowInfo>,
    signals: Signals,
    presence: PresenceState,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn known(value: bool, source: &str) -> Signal {
    Signal {
        value: Some(value),
        available: true,
        source: source.into(),
    }
}

/// Localisation seam: lower-case Name substrings that reveal mic/camera state. More specific needle first ("unmute" before "mute").
struct StateLabel {
    needle: &'static str,
    value: bool,
}

/// Mic button Name is the action verb: an "unmute" verb means you are muted; "mute" means live.
const MUTE_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "unmute",
        value: true,
    },
    StateLabel {
        needle: "mute",
        value: false,
    },
];

/// Video button Name: a "camera off" verb means the camera is on, and vice versa.
const CAMERA_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "camera off",
        value: true,
    },
    StateLabel {
        needle: "camera on",
        value: false,
    },
];

/// Raise-hand button Name is the action verb: a "lower" verb means the hand is raised, a "raise"
/// verb means it is lowered. Order matters: "raised" contains "raise", so the "lower" needle must be
/// tested first, or a label mentioning "raised" could be misread as lowered.
const HAND_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "lower",
        value: true,
    },
    StateLabel {
        needle: "raise",
        value: false,
    },
];

/// First label whose needle is in `name` (case-insensitive); None if none match.
fn match_label(name: &str, labels: &[StateLabel]) -> Option<bool> {
    let n = name.to_lowercase();
    labels
        .iter()
        .find(|l| n.contains(l.needle))
        .map(|l| l.value)
}

/// Language-independent camera read from Teams' OS webcam privacy record: LastUsedTimeStop==0 => camera on. None when unreadable.
fn teams_webcam_in_use() -> Option<bool> {
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\MSTeams_8wekyb3d8bbwe"
            ),
            w!("LastUsedTimeStop"),
            RRF_RT_REG_QWORD,
            None,
            Some((&mut value as *mut u64).cast::<core::ffi::c_void>()),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(value == 0)
}

fn has_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    find_first_id(automation, parent, aid).is_some()
}

/// Maps a control's localised Name to a Signal; an unrecognised label is tagged `uia-label?:<name>` for diagnostics.
fn label_signal(name: &str, labels: &[StateLabel]) -> Signal {
    match match_label(name, labels) {
        Some(v) => known(v, "uia-label"),
        None => Signal {
            value: None,
            available: false,
            source: format!("uia-label?:{name}"),
        },
    }
}

/// Cache request prefetching ClassName+Name so the top-level walk reads them locally (no per-window round-trip).
fn top_cache_request(
    automation: &UIAutomation,
) -> uiautomation::Result<uiautomation::core::UICacheRequest> {
    let req = automation.create_cache_request()?;
    req.add_property(UIProperty::ClassName)?;
    req.add_property(UIProperty::Name)?;
    Ok(req)
}

/// Caches the meeting HWND and its control elements (mic/camera/hangup) for reads and toggles; entries are validated live on use and cleared on HWND change.
struct MeetingCache {
    hwnd: Option<isize>,
    elems: Vec<(&'static str, UIElement)>,
}

impl MeetingCache {
    fn new() -> Self {
        MeetingCache {
            hwnd: None,
            elems: Vec::new(),
        }
    }

    /// Points the cache at `hwnd`, clearing cached elements when the window changes.
    fn rebind(&mut self, hwnd: Option<isize>) {
        if self.hwnd != hwnd {
            self.hwnd = hwnd;
            self.elems.clear();
        }
    }

    fn get(&self, aid: &str) -> Option<&UIElement> {
        self.elems.iter().find(|(a, _)| *a == aid).map(|(_, e)| e)
    }

    fn put(&mut self, aid: &'static str, el: UIElement) {
        self.elems.retain(|(a, _)| *a != aid);
        self.elems.push((aid, el));
    }

    fn drop_elem(&mut self, aid: &str) {
        self.elems.retain(|(a, _)| *a != aid);
    }
}

/// The control element for `aid`: a cached element re-validated by a live AutomationId read (dropped + re-found if stale), else found and cached. None if absent.
fn cached_elem(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    meeting: &UIElement,
    aid: &'static str,
) -> Option<UIElement> {
    if let Some(el) = cache.get(aid) {
        if matches!(el.get_automation_id(), Ok(ref a) if a == aid) {
            return Some(el.clone());
        }
        cache.drop_elem(aid);
    }
    let el = find_first_id(automation, meeting, aid)?;
    cache.put(aid, el.clone());
    Some(el)
}

/// A cached control's UIA Name (for the localised mute/camera labels), re-finding if stale. None if absent.
fn cached_name(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    meeting: &UIElement,
    aid: &'static str,
) -> Option<String> {
    cached_elem(automation, cache, meeting, aid)?
        .get_name()
        .ok()
}

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
fn presence_reader_loop(tx: Sender<Msg>, enabled: Arc<AtomicBool>, reseed: Arc<AtomicBool>) {
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

fn build_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    presence: &PresenceState,
) -> Snapshot {
    let mut snap = Snapshot {
        schema: 1,
        ts: now_ms(),
        teams_running: false,
        in_meeting: false,
        window: None,
        signals: Signals {
            mute: Signal::unknown(),
            camera: Signal::unknown(),
            hand: Signal::unknown(),
            sharing: Signal::unknown(),
        },
        presence: presence.clone(),
    };

    // Top-level pass: collect Teams-running (any TeamsWebView), screen-sharing (the sibling "Sharing
    // control bar" window) and the TeamsWebView meeting candidates, all from one cached round-trip.
    let mut sharing = false;
    let mut candidates: Vec<UIElement> = Vec::new();
    if let (Ok(root), Ok(true_cond), Ok(req)) = (
        automation.get_root_element(),
        automation.create_true_condition(),
        top_cache_request(automation),
    ) {
        if let Ok(top) = root.find_all_build_cache(TreeScope::Children, &true_cond, &req) {
            for w in &top {
                if w.get_cached_classname().unwrap_or_default() == "TeamsWebView" {
                    snap.teams_running = true;
                    candidates.push(w.clone());
                }
                if w.get_cached_name()
                    .unwrap_or_default()
                    .starts_with("Sharing control bar")
                {
                    sharing = true;
                }
            }
        }
    }

    if let Some(m) = locate_meeting(automation, cache, &candidates) {
        // The mic read is the liveness gate: present => in a meeting (else drop the cache and bail).
        match cached_name(automation, cache, &m, "microphone-button") {
            Some(mic) => {
                snap.in_meeting = true;
                // In a meeting implies Teams running, even if the top-level walk transiently missed it.
                snap.teams_running = true;
                snap.window = Some(WindowInfo {
                    pid: m.get_process_id().unwrap_or(0),
                    name: m.get_name().unwrap_or_default(),
                });
                snap.signals.mute = label_signal(&mic, MUTE_LABELS);
                // Prefer the OS webcam signal; fall back to the localised video-button label.
                snap.signals.camera = match teams_webcam_in_use() {
                    Some(on) => known(on, "os-webcam"),
                    None => match cached_name(automation, cache, &m, "video-button") {
                        Some(n) => label_signal(&n, CAMERA_LABELS),
                        None => Signal::unknown(),
                    },
                };
                // Hand state is read from the toolbar raise-hand button's localised Name (the action
                // verb), like mute/camera. May be absent in channel-meeting / live-event / 1:1
                // variants, in which case it renders unknown.
                snap.signals.hand = match cached_name(automation, cache, &m, "raisehands-button") {
                    Some(n) => label_signal(&n, HAND_LABELS),
                    None => Signal::unknown(),
                };
                snap.signals.sharing = known(sharing, "uia-window");
            }
            None => cache.rebind(None),
        }
    }

    // A stale last-known presence must not linger once Teams is gone: downgrade to Unknown while
    // keeping `source` so the plugin can still tell opt-in-off (`disabled`) from a running read
    // (`teams-log`). The log-derived value only means anything while Teams is alive to write it.
    if !snap.teams_running && snap.presence.value != Presence::Unknown {
        snap.presence.value = Presence::Unknown;
        snap.presence.known = false;
    }

    snap
}

/// Resolves the meeting window, preferring the cached HWND over a scan of the top-level `TeamsWebView`
/// candidates already enumerated by `build_snapshot` (so no second top-level enumeration). Clears the
/// cache when the window is gone or not a TeamsWebView; a wrong-window bind self-heals via the
/// caller's mic read.
fn locate_meeting(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    candidates: &[UIElement],
) -> Option<UIElement> {
    if let Some(h) = cache.hwnd {
        if let Ok(el) = automation.element_from_handle(Handle::from(h)) {
            if el
                .get_classname()
                .map(|c| c == "TeamsWebView")
                .unwrap_or(false)
            {
                return Some(el);
            }
        }
        cache.rebind(None);
    }
    let m = candidates
        .iter()
        .find(|w| is_meeting_window(automation, w))?
        .clone();
    cache.rebind(m.get_native_window_handle().ok().map(|h| h.into()));
    Some(m)
}

/// A top-level TeamsWebView containing both microphone- and hangup-button (an active meeting).
fn is_meeting_window(automation: &UIAutomation, w: &UIElement) -> bool {
    w.get_classname().unwrap_or_default() == "TeamsWebView"
        && has_id(automation, w, "microphone-button")
        && has_id(automation, w, "hangup-button")
}

/// Finds the active meeting window (TeamsWebView containing both microphone- and hangup-button).
fn find_meeting_window(automation: &UIAutomation) -> Option<UIElement> {
    let root = automation.get_root_element().ok()?;
    let true_cond = automation.create_true_condition().ok()?;
    let top = root.find_all(TreeScope::Children, &true_cond).ok()?;
    top.into_iter().find(|w| is_meeting_window(automation, w))
}

/// The top-level TeamsWebView windows (meeting-window candidates) for `locate_meeting`. The snapshot
/// path collects these inline during its single top-level pass; the command path enumerates here.
fn top_teamswebviews(automation: &UIAutomation) -> Vec<UIElement> {
    let (Ok(root), Ok(true_cond)) = (
        automation.get_root_element(),
        automation.create_true_condition(),
    ) else {
        return Vec::new();
    };
    let Ok(top) = root.find_all(TreeScope::Children, &true_cond) else {
        return Vec::new();
    };
    top.into_iter()
        .filter(|w| w.get_classname().unwrap_or_default() == "TeamsWebView")
        .collect()
}

fn find_first_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<UIElement> {
    let cond = automation
        .create_property_condition(UIProperty::AutomationId, Variant::from(aid), None)
        .ok()?;
    parent.find_first(TreeScope::Descendants, &cond).ok()
}

/// Actuates a control via the fast, focus-free MSAA default action (`accDoDefaultAction`); no focus/foreground change and no Invoke fallback needed (verified live across every control exercised; leave/hangup shares the same path).
fn actuate(el: &UIElement) -> bool {
    matches!(el.get_pattern::<UILegacyIAccessiblePattern>(), Ok(p) if p.do_default_action().is_ok())
}

/// Runs a flyout action on a short-lived worker (own `UIAutomation`, no event handlers) so a slow `expand()` can't freeze the snapshot stream. Resolves the meeting from the cached HWND.
fn run_flyout_worker(hwnd: Option<isize>, aid: &str) -> bool {
    let Ok(automation) = UIAutomation::new() else {
        return false;
    };
    let meeting = hwnd
        .and_then(|h| automation.element_from_handle(Handle::from(h)).ok())
        .filter(|el| is_meeting_window(&automation, el))
        .or_else(|| find_meeting_window(&automation));
    match meeting {
        Some(m) => run_flyout(&automation, &m, aid),
        None => false,
    }
}

/// Opens the React flyout, actuates the item by AutomationId, then closes it. Focus-free throughout.
fn run_flyout(automation: &UIAutomation, meeting: &UIElement, aid: &str) -> bool {
    let Some(react) = find_first_id(automation, meeting, "reaction-menu-button") else {
        return false;
    };
    let ec = react.get_pattern::<UIExpandCollapsePattern>().ok();
    if let Some(p) = &ec {
        let _ = p.expand();
    }
    // The flyout DOM builds lazily (~95ms in the live spike); poll for the item up to ~750ms, but try
    // immediately first (the menu may already be open from a prior action).
    let mut ok = false;
    for i in 0..15 {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(50));
        }
        if let Some(el) = find_first_id(automation, meeting, aid) {
            ok = actuate(&el);
            break;
        }
    }
    close_flyout(automation, meeting, &react, ec.as_ref());
    ok
}

/// Closes the React flyout deterministically: `collapse()`, and only if still Expanded re-actuate the React button (re-invoking an already-closed menu would re-open it); then wait up to ~500ms for microphone-button to return so the disrupted tree never leaks into the next command.
fn close_flyout(
    automation: &UIAutomation,
    meeting: &UIElement,
    react: &UIElement,
    ec: Option<&UIExpandCollapsePattern>,
) {
    // No ExpandCollapse pattern means the flyout was never opened: nothing to close, no wait.
    let Some(p) = ec else {
        return;
    };
    let _ = p.collapse();
    if matches!(p.get_state(), Ok(ExpandCollapseState::Expanded)) {
        let _ = actuate(react);
    }
    for _ in 0..10 {
        if find_first_id(automation, meeting, "microphone-button").is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn react_id(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "like" => "like-button",
        "love" => "heart-button",
        "laugh" => "laugh-button",
        "surprised" => "surprised-button",
        "applause" => "applause-button",
        _ => return None,
    })
}

/// What a command verb maps to, decided without touching UIA (unit-testable). `Noop` never actuates.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Actuate a single control by AutomationId (mute / camera / leave / raise-hand).
    Toggle(&'static str),
    /// Open the React flyout and actuate an item by AutomationId (reactions).
    Flyout(&'static str),
    /// Unknown verb or unrecognised reaction: do nothing, report ok:false, no retry.
    Noop,
}

/// Maps a wire verb (and optional arg) to its control action, purely (no UIA). See `Action`.
fn route(verb: &str, arg: Option<&str>) -> Action {
    match verb {
        "toggle-mute" => Action::Toggle("microphone-button"),
        "toggle-camera" => Action::Toggle("video-button"),
        "leave" => Action::Toggle("hangup-button"),
        // Raise-hand is a main-toolbar button again (a peer of mic/camera), so actuate it directly
        // via the focus-free MSAA path (do_default_action), like mute. If Teams moves it back under
        // the React flyout the button goes absent and act_toggle surfaces ok:false; note a
        // reworked-but-present control could no-op silently, as do_default_action reports success.
        "raise-hand" => Action::Toggle("raisehands-button"),
        "react" => match arg.and_then(react_id) {
            Some(id) => Action::Flyout(id),
            None => Action::Noop,
        },
        _ => Action::Noop,
    }
}

/// Actuates a toggle control (mute/camera/leave) on the cached window, re-finding once if it's absent so a press is never silently dropped. Runs inline (DoDefaultAction is fast).
fn act_toggle(automation: &UIAutomation, cache: &mut MeetingCache, aid: &'static str) -> bool {
    // Fast path: a valid cached window actuates with no top-level enumeration (the common in-call case).
    if let Some(m) = locate_meeting(automation, cache, &[]) {
        if let Some(el) = cached_elem(automation, cache, &m, aid) {
            let ok = actuate(&el);
            // Validated element that still didn't actuate (transient rebuild): drop it so the next press/tick re-finds; no in-call retry.
            if !ok {
                cache.drop_elem(aid);
            }
            return ok;
        }
    }
    // Cache empty/stale or control absent: enumerate once and retry against a fresh meeting.
    cache.rebind(None);
    let candidates = top_teamswebviews(automation);
    match locate_meeting(automation, cache, &candidates) {
        Some(m) => cached_elem(automation, cache, &m, aid)
            .map(|el| actuate(&el))
            .unwrap_or(false),
        None => false,
    }
}

/// Messages the serve loop multiplexes: a stdin command, a state-changed ping from a UIA handler, and a worker's result line.
enum Msg {
    Cmd(String),
    Ping,
    Result(String),
    /// A presence change read from the Teams log by the background presence reader.
    Presence(Presence),
    /// stdin EOF (parent gone): exit. Needed because UIA handlers hold their own `Sender` clones, so dropping the reader's tx no longer disconnects the channel.
    Eof,
}

// Compile-time assert that the handler-captured `Sender<Msg>` is Send+Sync (the crate stores handlers with no such bound).
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Sender<Msg>>();
};

/// A live subtree PropertyChanged(Name) registration bound to one meeting window; removed by identity when the window changes.
struct NameReg {
    handler: UIPropertyChangedEventHandler,
    window: UIElement,
    hwnd: isize,
}

/// Whether `hwnd` still resolves to a live Teams meeting WebView (alive but possibly auto-hidden).
fn window_alive(automation: &UIAutomation, hwnd: isize) -> bool {
    automation
        .element_from_handle(Handle::from(hwnd))
        .ok()
        .and_then(|el| el.get_classname().ok())
        .map(|c| c == "TeamsWebView")
        .unwrap_or(false)
}

/// Root window open/close handlers (latency shorteners), kept alive for the serve lifetime. Opens filtered to relevant windows; closes always ping; handlers only send.
fn register_window_handlers(
    automation: &UIAutomation,
    tx: &Sender<Msg>,
) -> Option<(UIEventHandler, UIEventHandler, UIElement)> {
    let root = automation.get_root_element().ok()?;
    let req = top_cache_request(automation).ok()?;
    let opened: UIEventHandler = (Box::new({
        let tx = tx.clone();
        move |e: &UIElement, _ev| {
            let cls = e.get_cached_classname().unwrap_or_default();
            let name = e.get_cached_name().unwrap_or_default();
            if cls == "TeamsWebView" || name.starts_with("Sharing control bar") {
                let _ = tx.send(Msg::Ping);
            }
            Ok(())
        }
    }) as Box<CustomEventHandlerFn>)
        .into();
    let closed: UIEventHandler = (Box::new({
        let tx = tx.clone();
        move |e: &UIElement, _ev| {
            // Ping only when a tracked window closes. Transient WebView2 child windows close with an
            // empty ClassName (verified), so empty is ignored -- treating it as relevant pinged on
            // every tooltip/popup close. A meeting/Teams or sharing window that still carries its
            // ClassName/Name is caught here; a leave that arrives empty is reconciled by the
            // in-meeting backstop tick.
            let cls = e.get_cached_classname().unwrap_or_default();
            let name = e.get_cached_name().unwrap_or_default();
            if cls == "TeamsWebView" || name.starts_with("Sharing control bar") {
                let _ = tx.send(Msg::Ping);
            }
            Ok(())
        }
    }) as Box<CustomEventHandlerFn>)
        .into();
    automation
        .add_automation_event_handler(
            UIEventType::Window_WindowOpened,
            &root,
            TreeScope::Subtree,
            Some(&req),
            &opened,
        )
        .ok()?;
    automation
        .add_automation_event_handler(
            UIEventType::Window_WindowClosed,
            &root,
            TreeScope::Subtree,
            Some(&req),
            &closed,
        )
        .ok()?;
    Some((opened, closed, root))
}

/// Subtree PropertyChanged(Name) handler on the meeting window; prefetches AutomationId so it filters to mic/video/raise-hand with no per-event UIA read. Only pings.
fn register_name_handler(
    automation: &UIAutomation,
    hwnd: isize,
    tx: Sender<Msg>,
) -> Option<NameReg> {
    let window = automation.element_from_handle(Handle::from(hwnd)).ok()?;
    let req = automation.create_cache_request().ok()?;
    // Only AutomationId is read in the handler; the new Name value is unused, so don't prefetch it.
    req.add_property(UIProperty::AutomationId).ok()?;
    let handler: UIPropertyChangedEventHandler = (Box::new(move |e: &UIElement, _p, _v| {
        if let Ok(aid) = e.get_cached_automation_id() {
            if aid == "microphone-button" || aid == "video-button" || aid == "raisehands-button" {
                let _ = tx.send(Msg::Ping);
            }
        }
        Ok(())
    })
        as Box<CustomPropertyChangedEventHandlerFn>)
        .into();
    automation
        .add_property_changed_event_handler(
            &window,
            TreeScope::Subtree,
            Some(&req),
            &handler,
            &[UIProperty::Name],
        )
        .ok()?;
    Some(NameReg {
        handler,
        window,
        hwnd,
    })
}

/// Keeps the Name handler bound to the live meeting window, decoupled from `inMeeting`: rebinds on window change, tears down only when the window is gone (not when the control bar auto-hides).
fn reconcile_name_handler(
    automation: &UIAutomation,
    name_reg: &mut Option<NameReg>,
    hwnd: Option<isize>,
    in_meeting: bool,
    tx: &Sender<Msg>,
) {
    let desired = if in_meeting {
        hwnd
    } else {
        name_reg
            .as_ref()
            .map(|r| r.hwnd)
            .filter(|&h| window_alive(automation, h))
    };
    // Short-circuit on HWND identity; the rare HWND-reuse and cache-None edges self-heal on a later tick.
    if name_reg.as_ref().map(|r| r.hwnd) == desired {
        return;
    }
    if let Some(reg) = name_reg.take() {
        let _ = automation.remove_property_changed_event_handler(&reg.window, &reg.handler);
    }
    if let Some(h) = desired {
        *name_reg = register_name_handler(automation, h, tx.clone());
    }
}

fn emit_line(s: &str) -> bool {
    let out = std::io::stdout();
    let mut h = out.lock();
    writeln!(h, "{s}").and_then(|_| h.flush()).is_ok()
}

/// Builds the `{"type":"result",...}` line; single source of truth for the wire result contract.
fn result_line(verb: &str, arg: Option<&str>, ok: bool) -> String {
    serde_json::json!({ "type": "result", "cmd": verb, "arg": arg, "ok": ok }).to_string()
}

/// Emits one snapshot line and reconciles the Name handler. Returns `Some(in_meeting)` on success;
/// `None` only when the stdout pipe is broken (parent gone).
fn emit_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    name_reg: &mut Option<NameReg>,
    tx: &Sender<Msg>,
    presence: &PresenceState,
) -> Option<bool> {
    let snap = build_snapshot(automation, cache, presence);
    let in_meeting = snap.in_meeting;
    reconcile_name_handler(automation, name_reg, cache.hwnd, in_meeting, tx);
    let ok = match serde_json::to_value(&snap) {
        Ok(mut v) => {
            v["type"] = serde_json::json!("snapshot");
            emit_line(&v.to_string())
        }
        Err(_) => true,
    };
    ok.then_some(in_meeting)
}

/// Whether the loop should emit now: a snapshot is pending (`dirty`) and the debounce has elapsed.
fn should_emit(dirty: bool, since_emit: Duration, debounce: Duration) -> bool {
    dirty && since_emit >= debounce
}

/// How long to wait for the next message: remaining debounce while a snapshot is pending, else the full idle tick.
fn loop_wait(dirty: bool, since_emit: Duration, debounce: Duration, tick: Duration) -> Duration {
    if dirty {
        debounce.saturating_sub(since_emit)
    } else {
        tick
    }
}

/// The backstop interval between forced resnapshots, chosen by meeting state. The event handlers
/// (window open/close, mic/camera Name changes) drive real state changes, so this only reconciles a
/// *missed* event: short in a meeting (bounds a missed mute/leave) and long otherwise, where a
/// window-open event catches a meeting starting and nothing else needs polling.
fn effective_tick(in_meeting: bool, meeting_tick: Duration, idle_tick: Duration) -> Duration {
    if in_meeting {
        meeting_tick
    } else {
        idle_tick
    }
}

/// Persistent service: streams snapshot + result JSON on stdout, reads command JSON on stdin.
/// Event-driven (Name + window handlers, ~70-100ms) over an adaptive backstop tick (short in a
/// meeting, long otherwise; see `effective_tick`), snapshots debounced to ~150ms. Exits when stdin
/// or stdout closes.
fn serve(automation: &UIAutomation) {
    let (tx, rx) = mpsc::channel::<Msg>();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) => {
                        if tx.send(Msg::Cmd(l)).is_err() {
                            break;
                        }
                    }
                    // A broken Windows pipe yields a repeating read error, not clean EOF: stop on it; skip only non-UTF-8 lines.
                    Err(e) if e.kind() == ErrorKind::InvalidData => continue,
                    Err(_) => break,
                }
            }
            // stdin EOF (parent gone): tell the loop to exit (handlers hold their own tx clones).
            let _ = tx.send(Msg::Eof);
        });
    }

    // Opt-in gate for reading presence from the Teams log; default OFF until the plugin enables it.
    // The background reader thread watches this and only tails the log while it is set. `presence_reseed`
    // forces a fresh seed on every opt-in "on" so a rapid off/on re-toggle can't leave the tile stuck.
    let presence_enabled = Arc::new(AtomicBool::new(false));
    let presence_reseed = Arc::new(AtomicBool::new(false));
    {
        let tx = tx.clone();
        let enabled = Arc::clone(&presence_enabled);
        let reseed = Arc::clone(&presence_reseed);
        std::thread::spawn(move || presence_reader_loop(tx, enabled, reseed));
    }
    // Last presence read from the log, embedded into every snapshot. Starts disabled (opt-in off).
    let mut current_presence = PresenceState::disabled();

    // HWND of the active meeting window plus its cached control elements (see `MeetingCache`).
    let mut cache = MeetingCache::new();
    // The meeting-bound Name handler, rebound as the meeting window changes.
    let mut name_reg: Option<NameReg> = None;
    // Long-lived root window handlers; on failure the loop still runs on the tick + Name handler.
    let window_reg = register_window_handlers(automation, &tx);
    if window_reg.is_none() {
        eprintln!("teamdeck-helper: window event handlers failed to register; relying on the tick");
    }

    let debounce = Duration::from_millis(150);
    // Backstop ticks (see `effective_tick`): the event handlers do the real work, so these only
    // reconcile a missed event. Short in a meeting bounds a missed mute/leave; long otherwise keeps
    // the helper near-idle while window-open events catch a meeting starting.
    let meeting_tick = Duration::from_secs(5);
    let idle_tick = Duration::from_secs(15);
    // Start "dirty" with a back-dated last-emit so the first snapshot fires immediately.
    let mut dirty = true;
    let mut in_meeting = false;
    let mut last_emit = Instant::now()
        .checked_sub(debounce)
        .unwrap_or_else(Instant::now);

    loop {
        if should_emit(dirty, last_emit.elapsed(), debounce) {
            match emit_snapshot(
                automation,
                &mut cache,
                &mut name_reg,
                &tx,
                &current_presence,
            ) {
                None => break, // stdout pipe broken: parent gone.
                Some(im) => {
                    in_meeting = im;
                    last_emit = Instant::now();
                    dirty = false;
                }
            }
        }
        let tick = effective_tick(in_meeting, meeting_tick, idle_tick);
        let wait = loop_wait(dirty, last_emit.elapsed(), debounce, tick);
        match rx.recv_timeout(wait) {
            Ok(Msg::Cmd(line)) => {
                // The opt-in gate is a serve-state flag, not a UIA control action, so handle it here
                // rather than in `route()`/`handle_command`.
                if let Some(on) = parse_log_reading_cmd(&line) {
                    if on {
                        // Request a fresh seed on every "on"; only reset the shown value to "seeking"
                        // on a real off->on transition, so a redundant "on" doesn't flash unknown
                        // (the reseed re-reports the current value).
                        let was_off = !presence_enabled.swap(true, Ordering::Relaxed);
                        presence_reseed.store(true, Ordering::Relaxed);
                        if was_off {
                            current_presence = PresenceState::seeking();
                        }
                    } else {
                        presence_enabled.store(false, Ordering::Relaxed);
                        current_presence = PresenceState::disabled();
                    }
                    if !emit_line(&result_line(
                        "set-log-reading",
                        Some(if on { "on" } else { "off" }),
                        true,
                    )) {
                        break;
                    }
                    dirty = true;
                } else {
                    match handle_command(automation, &mut cache, &line, &tx) {
                        Handled::Stop => break, // stdout pipe broken: parent gone.
                        // Flyout: its worker emits the post-settle snapshot, so don't snapshot mid-rebuild here.
                        Handled::Go { snapshot } => {
                            if snapshot {
                                dirty = true;
                            }
                        }
                    }
                }
            }
            Ok(Msg::Ping) => dirty = true,
            Ok(Msg::Presence(p)) => {
                // Ignore a stale read that lands just after opt-out.
                if presence_enabled.load(Ordering::Relaxed) {
                    current_presence = PresenceState::from_value(p);
                    dirty = true;
                }
            }
            Ok(Msg::Result(line)) => {
                if !emit_line(&line) {
                    break;
                }
                dirty = true;
            }
            Ok(Msg::Eof) => break, // stdin closed: parent gone.
            // Timeout = the adaptive backstop tick, or the debounce window elapsing: resnapshot either way.
            Err(mpsc::RecvTimeoutError::Timeout) => dirty = true,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Stop new callbacks, then exit hard so an in-flight RPC callback can't race the COM teardown.
    let _ = automation.remove_all_event_handlers();
    std::process::exit(0);
}

/// Outcome of handling one command line, returned to the serve loop.
enum Handled {
    /// Keep serving; `snapshot` requests an immediate post-command snapshot (true for inline toggle/noop, false for flyout).
    Go { snapshot: bool },
    /// The stdout pipe broke (parent gone): stop serving.
    Stop,
}

/// Detects the presence opt-in command `{"cmd":"set-log-reading","arg":"on|off"}`, returning the
/// desired enabled state. `None` for any other line, so normal commands fall through to `handle_command`.
fn parse_log_reading_cmd(line: &str) -> Option<bool> {
    let cmd = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    if cmd.get("cmd").and_then(|v| v.as_str())? != "set-log-reading" {
        return None;
    }
    match cmd.get("arg").and_then(|v| v.as_str())? {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

/// Parses one command line and acts: toggles run inline and emit immediately; flyout actions run on a worker that funnels its result via `Msg::Result`.
fn handle_command(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    line: &str,
    tx: &Sender<Msg>,
) -> Handled {
    let line = line.trim();
    if line.is_empty() {
        return Handled::Go { snapshot: false };
    }
    let Ok(cmd) = serde_json::from_str::<serde_json::Value>(line) else {
        return Handled::Go { snapshot: false };
    };
    let verb = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    let arg = cmd.get("arg").and_then(|v| v.as_str());
    match route(verb, arg) {
        Action::Flyout(aid) => {
            let hwnd = cache.hwnd;
            let verb = verb.to_string();
            let arg = arg.map(str::to_string);
            let tx = tx.clone();
            std::thread::spawn(move || {
                let ok = run_flyout_worker(hwnd, aid);
                let _ = tx.send(Msg::Result(result_line(&verb, arg.as_deref(), ok)));
            });
            Handled::Go { snapshot: false }
        }
        Action::Toggle(aid) => {
            if emit_line(&result_line(verb, arg, act_toggle(automation, cache, aid))) {
                Handled::Go { snapshot: true }
            } else {
                Handled::Stop
            }
        }
        Action::Noop => {
            if emit_line(&result_line(verb, arg, false)) {
                Handled::Go { snapshot: true }
            } else {
                Handled::Stop
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let automation = match UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("failed to init UIAutomation: {e}");
            std::process::exit(1);
        }
    };

    // Persistent service mode (used by the plugin):  teamdeck-helper serve
    if args.get(1).map(|s| s.as_str()) == Some("serve") {
        serve(&automation);
        return;
    }

    // Read mode (used by the CI and release smoke tests): emit one snapshot and exit. Presence is
    // opt-in and never read in one-shot mode, so it reports disabled.
    let snap = build_snapshot(
        &automation,
        &mut MeetingCache::new(),
        &PresenceState::disabled(),
    );
    println!("{}", serde_json::to_string(&snap).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_label_reads_the_action_verb() {
        assert_eq!(
            match_label("Unmute mic", MUTE_LABELS),
            Some(true),
            "Unmute => muted"
        );
        assert_eq!(
            match_label("Mute mic", MUTE_LABELS),
            Some(false),
            "Mute => unmuted"
        );
        assert_eq!(match_label("Microphone", MUTE_LABELS), None);
    }

    #[test]
    fn label_matching_is_case_insensitive_and_order_aware() {
        // The seam matches case-insensitively, so a localised label in any casing still resolves.
        assert_eq!(match_label("UNMUTE MIC", MUTE_LABELS), Some(true));
        assert_eq!(match_label("unmute mic", MUTE_LABELS), Some(true));
        // "unmute" contains "mute": the more specific needle must win, never collapse to unmuted.
        assert_eq!(
            match_label("Unmute", MUTE_LABELS),
            Some(true),
            "must not match the 'mute' needle first"
        );
        assert_eq!(match_label("turn camera on", CAMERA_LABELS), Some(false));
    }

    #[test]
    fn camera_label_is_case_insensitive() {
        assert_eq!(
            match_label("Turn camera off", CAMERA_LABELS),
            Some(true),
            "off label => camera on"
        );
        assert_eq!(match_label("TURN CAMERA OFF", CAMERA_LABELS), Some(true));
        assert_eq!(
            match_label("Turn camera on", CAMERA_LABELS),
            Some(false),
            "on label => camera off"
        );
        assert_eq!(match_label("No control here", CAMERA_LABELS), None);
    }

    #[test]
    fn hand_label_reads_the_action_verb() {
        // The Name is the action verb: "Lower your hand" => raised, "Raise your hand" => lowered.
        assert_eq!(match_label("Lower your hand", HAND_LABELS), Some(true));
        assert_eq!(match_label("Raise your hand", HAND_LABELS), Some(false));
        // Case-insensitive, so a localised label in any casing still resolves.
        assert_eq!(match_label("LOWER YOUR HAND", HAND_LABELS), Some(true));
        // Order is load-bearing: "raised" contains "raise", so a label mentioning "raised" must not
        // collapse to lowered; the "lower" needle is tested first.
        assert_eq!(
            match_label("Hand raised, lower your hand", HAND_LABELS),
            Some(true)
        );
        assert_eq!(match_label("Microphone", HAND_LABELS), None);
    }

    #[test]
    fn react_id_maps_every_reaction() {
        assert_eq!(react_id("like"), Some("like-button"));
        assert_eq!(react_id("love"), Some("heart-button"));
        assert_eq!(react_id("laugh"), Some("laugh-button"));
        assert_eq!(react_id("surprised"), Some("surprised-button"));
        assert_eq!(react_id("applause"), Some("applause-button"));
        assert_eq!(react_id("nope"), None);
    }

    #[test]
    fn route_maps_verbs_and_treats_unknowns_as_noop() {
        assert_eq!(
            route("toggle-mute", None),
            Action::Toggle("microphone-button")
        );
        assert_eq!(route("toggle-camera", None), Action::Toggle("video-button"));
        assert_eq!(route("leave", None), Action::Toggle("hangup-button"));
        assert_eq!(
            route("raise-hand", None),
            Action::Toggle("raisehands-button")
        );
        assert_eq!(route("react", Some("like")), Action::Flyout("like-button"));
        assert_eq!(
            route("react", Some("surprised")),
            Action::Flyout("surprised-button")
        );
        // Unknown verb and unrecognised reaction collapse to Noop: ok:false, and crucially no
        // stale-cache retry (so a bad command can never be mistaken for a stale window or double-act).
        assert_eq!(route("react", Some("nope")), Action::Noop);
        assert_eq!(route("react", None), Action::Noop);
        assert_eq!(route("bogus", None), Action::Noop);
    }

    #[test]
    fn snapshot_serialises_the_wire_contract() {
        let snap = Snapshot {
            schema: 1,
            ts: 0,
            teams_running: true,
            in_meeting: true,
            window: None,
            signals: Signals {
                mute: known(false, "uia-label"),
                camera: Signal::unknown(),
                hand: Signal::unknown(),
                sharing: known(true, "uia-window"),
            },
            presence: PresenceState::from_value(Presence::DoNotDisturb),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&snap).unwrap()).unwrap();
        assert_eq!(
            v["teamsRunning"],
            serde_json::json!(true),
            "uses the renamed key"
        );
        assert_eq!(v["inMeeting"], serde_json::json!(true));
        assert!(
            v.get("teams_running").is_none(),
            "must not emit the snake_case field name"
        );
        assert_eq!(v["signals"]["mute"]["value"], serde_json::json!(false));
        assert_eq!(v["signals"]["mute"]["available"], serde_json::json!(true));
        // Presence is a camelCase enum string plus its known flag and a fixed source token.
        assert_eq!(v["presence"]["value"], serde_json::json!("doNotDisturb"));
        assert_eq!(v["presence"]["known"], serde_json::json!(true));
        assert_eq!(v["presence"]["source"], serde_json::json!("teams-log"));
    }

    #[test]
    fn result_line_is_byte_stable() {
        // The plugin parses these JSON-order-independently, but the bytes are locked so a refactor
        // can't silently change the wire result contract (serde_json sorts keys: arg, cmd, ok, type).
        assert_eq!(
            result_line("toggle-mute", None, true),
            r#"{"arg":null,"cmd":"toggle-mute","ok":true,"type":"result"}"#
        );
        assert_eq!(
            result_line("react", Some("like"), false),
            r#"{"arg":"like","cmd":"react","ok":false,"type":"result"}"#
        );
    }

    #[test]
    fn meeting_cache_rebind_tracks_hwnd_and_is_idempotent() {
        // The element-bearing paths (put/get/validated reuse across a control-bar rebuild) are
        // exercised live -- a UIElement is a COM wrapper that can't be built in a unit test -- so this
        // locks the pure HWND state machine: a new cache is empty, rebinding to the same window is a
        // no-op, and any window change re-points the cache (dropping the now-foreign elements).
        let mut c = MeetingCache::new();
        assert_eq!(c.hwnd, None);
        assert!(c.get("microphone-button").is_none());
        c.rebind(Some(10));
        assert_eq!(c.hwnd, Some(10));
        c.rebind(Some(10)); // same window: idempotent
        assert_eq!(c.hwnd, Some(10));
        c.rebind(Some(20)); // changed window: re-point
        assert_eq!(c.hwnd, Some(20));
        c.drop_elem("microphone-button"); // safe on an empty element set
        c.rebind(None);
        assert_eq!(c.hwnd, None);
        assert!(c.get("video-button").is_none());
    }

    #[test]
    fn should_emit_requires_dirty_and_debounce_elapsed() {
        let d = Duration::from_millis(150);
        assert!(
            !should_emit(false, Duration::from_secs(10), d),
            "clean: never emit"
        );
        assert!(
            !should_emit(true, Duration::from_millis(100), d),
            "dirty but still within the debounce window"
        );
        assert!(
            should_emit(true, Duration::from_millis(150), d),
            "dirty and the debounce has elapsed"
        );
        assert!(should_emit(true, Duration::from_millis(300), d));
    }

    #[test]
    fn loop_wait_debounces_when_dirty_else_idles() {
        let d = Duration::from_millis(150);
        let t = Duration::from_secs(1);
        assert_eq!(
            loop_wait(false, Duration::ZERO, d, t),
            t,
            "clean: wait the idle tick"
        );
        assert_eq!(loop_wait(false, Duration::from_secs(9), d, t), t);
        assert_eq!(
            loop_wait(true, Duration::from_millis(40), d, t),
            Duration::from_millis(110),
            "dirty: wait out the remaining debounce"
        );
        assert_eq!(
            loop_wait(true, Duration::from_millis(200), d, t),
            Duration::ZERO,
            "dirty and overdue: emit on the next loop without sleeping"
        );
    }

    #[test]
    fn effective_tick_is_short_in_meeting_and_long_otherwise() {
        let meeting = Duration::from_secs(5);
        let idle = Duration::from_secs(15);
        assert_eq!(
            effective_tick(true, meeting, idle),
            meeting,
            "in a meeting: short backstop bounds a missed mute/leave"
        );
        assert_eq!(
            effective_tick(false, meeting, idle),
            idle,
            "out of a meeting: long backstop, events catch a meeting starting"
        );
    }

    // --- Presence (Teams-log) ---

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
    fn parse_log_reading_cmd_detects_the_opt_in_only() {
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"on"}"#),
            Some(true)
        );
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"off"}"#),
            Some(false)
        );
        // A bad arg, a different verb, and non-JSON all fall through to the normal command path.
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"maybe"}"#),
            None
        );
        assert_eq!(parse_log_reading_cmd(r#"{"cmd":"toggle-mute"}"#), None);
        assert_eq!(parse_log_reading_cmd("not json"), None);
    }

    #[test]
    fn presence_state_known_flag_and_sources() {
        // Unknown is never "known" (renders unavailable); a real value is.
        assert!(!PresenceState::from_value(Presence::Unknown).known);
        assert!(PresenceState::from_value(Presence::Busy).known);
        // The three fixed source tokens the plugin distinguishes; never raw log text.
        assert_eq!(PresenceState::disabled().source, "disabled");
        assert_eq!(PresenceState::seeking().source, "teams-log");
        assert_eq!(
            PresenceState::from_value(Presence::Away).source,
            "teams-log"
        );
    }

    #[test]
    fn presence_serialises_as_camel_case() {
        let v = serde_json::to_value(PresenceState::from_value(Presence::BeRightBack)).unwrap();
        assert_eq!(v["value"], serde_json::json!("beRightBack"));
        assert_eq!(v["known"], serde_json::json!(true));
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
