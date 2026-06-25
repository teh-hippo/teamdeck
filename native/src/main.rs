//! TeamDeck native helper.
//!
//! Reads Microsoft Teams meeting state via Windows UI Automation and actuates the meeting controls.
//! Emits the snapshot contract as one JSON object per line on stdout.

use serde::Serialize;
use std::io::{BufRead, ErrorKind, Write};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use uiautomation::events::{
    CustomEventHandlerFn, CustomPropertyChangedEventHandlerFn, UIEventHandler, UIEventType,
    UIPropertyChangedEventHandler,
};
use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern,
};
use uiautomation::types::{ExpandCollapseState, Handle, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use windows::core::w;
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_QWORD};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
};

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

#[derive(Serialize)]
struct WindowInfo {
    pid: u32,
    name: String,
}

/// The snapshot contract emitted as one JSON line per tick. `teamsRunning`, `inMeeting` and
/// `signals` drive the plugin; `schema`, `ts`, `window` and each signal's `source` are diagnostic
/// fields for a human inspecting the helper, not consumed by the plugin's mapper.
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

/// Localisation seam: UI label fragments that reveal mic/camera state from a control's UIA Name
/// (the action verb). Teams exposes mic/camera on-off state only as localised text, so supporting
/// another display language means adding its verbs here -- the only change a new locale needs.
/// Order matters: list more specific needles first (e.g. "unmute" before "mute", which it contains).
struct StateLabel {
    /// Lower-case substring to look for in the control's Name.
    needle: &'static str,
    /// The boolean state that substring implies.
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

/// Resolves a control's boolean state from its (localised) Name via the first matching label,
/// matched case-insensitively. Returns None when no known label matches, so the caller marks the
/// control unknown rather than guessing.
fn match_label(name: &str, labels: &[StateLabel]) -> Option<bool> {
    let n = name.to_lowercase();
    labels
        .iter()
        .find(|l| n.contains(l.needle))
        .map(|l| l.value)
}

/// microphone-button Name is the action verb: "Unmute mic" => muted, "Mute mic" => unmuted.
fn map_mute(name: &str) -> Option<bool> {
    match_label(name, MUTE_LABELS)
}

/// video-button Name: "Turn camera off" => camera on, "Turn camera on" => off.
fn map_camera(name: &str) -> Option<bool> {
    match_label(name, CAMERA_LABELS)
}

/// Camera-on state read from the OS, independent of Teams' display language: the per-app webcam
/// privacy record. `LastUsedTimeStop == 0` means Microsoft Teams is currently capturing video
/// (camera on); a non-zero FILETIME means capture stopped (camera off). Returns `None` when the
/// record is missing or unreadable, so the caller falls back to the localised button label.
/// `MSTeams_8wekyb3d8bbwe` is new Teams' fixed Microsoft Store identity.
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

/// Maps a control's (localised) UIA Name to a Signal: a recognised label gives a known value, an
/// unrecognised one is tagged `uia-label?:<name>` so the plugin can surface it as a diagnostic.
fn label_signal(name: &str, map: fn(&str) -> Option<bool>) -> Signal {
    match map(name) {
        Some(v) => known(v, "uia-label"),
        None => Signal {
            value: None,
            available: false,
            source: format!("uia-label?:{name}"),
        },
    }
}

/// A cache request that fetches each element's ClassName and Name in the same cross-process call as
/// the enumeration, so the per-window reads in the top-level walk are local (no UIA round-trip each).
fn top_cache_request(
    automation: &UIAutomation,
) -> uiautomation::Result<uiautomation::core::UICacheRequest> {
    let req = automation.create_cache_request()?;
    req.add_property(UIProperty::ClassName)?;
    req.add_property(UIProperty::Name)?;
    Ok(req)
}

/// Caches the active meeting window HWND plus the control elements found within it (mic / camera /
/// hangup buttons). Both the snapshot reads and the toggle commands reuse these elements, turning a
/// ~38ms `find_first` descendant tree search into a ~0.3ms property read / actuation. Each element is
/// validated live on use -- a dead or detached Chromium element's `get_automation_id` returns Err, so
/// a stale entry is dropped and re-found -- so the cache is never less reliable than a fresh search,
/// only faster. Element entries are cleared whenever the HWND changes (a new / re-joined meeting).
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

    /// Points the cache at `hwnd`, dropping all cached elements when the window changes (so elements
    /// from a previous meeting can never leak into a new one).
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

/// Returns the meeting's control element for `aid`, preferring a live-validated cached element and
/// otherwise finding it once and caching it. The cached element is trusted only if it still reports
/// the expected AutomationId on a *current* (cross-process, non-cached) read -- a detached element
/// errors there, so this both proves liveness and guards against an HWND-reuse mismatch. Returns
/// `None` only when the control is genuinely absent from the meeting tree.
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

/// Reads a cached control's UIA Name (used for the localised mute / camera labels), re-finding the
/// element if the cached one went stale. `None` when the control is absent.
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

fn build_snapshot(automation: &UIAutomation, cache: &mut MeetingCache) -> Snapshot {
    let mut snap = Snapshot {
        schema: 1,
        ts: now_ms(),
        teams_running: false,
        in_meeting: false,
        window: None,
        signals: Signals {
            mute: Signal::unknown(),
            camera: Signal::unknown(),
            hand: Signal {
                value: None,
                available: false,
                source: "flyout-only".into(),
            },
            sharing: Signal::unknown(),
        },
    };

    // Top-level pass for Teams-running (any TeamsWebView) and screen-sharing (a sibling "Sharing
    // control bar" window). Both need this enumeration, so a cache request fetches ClassName + Name
    // in one round-trip and the reads below are local. On a warm cache `locate_meeting` reuses the
    // cached HWND and skips re-finding; only a cold tick pays a second top-level walk (inside
    // `find_meeting_window`), which is rare (startup / post-invalidation).
    let mut sharing = false;
    if let (Ok(root), Ok(true_cond), Ok(req)) = (
        automation.get_root_element(),
        automation.create_true_condition(),
        top_cache_request(automation),
    ) {
        if let Ok(top) = root.find_all_build_cache(TreeScope::Children, &true_cond, &req) {
            for w in &top {
                if w.get_cached_classname().unwrap_or_default() == "TeamsWebView" {
                    snap.teams_running = true;
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

    if let Some(m) = locate_meeting(automation, cache) {
        // Liveness is confirmed by the mic read itself -- a live meeting always exposes
        // microphone-button -- so there is no separate validation probe. If the cached window no
        // longer has it (meeting ended / window reused), drop the cache and report not-in-meeting.
        match cached_name(automation, cache, &m, "microphone-button") {
            Some(mic) => {
                // A live meeting always exposes microphone-button; on the warm path this mic read
                // is the only liveness gate (vs the cold path's strict mic+hangup match) -- a small,
                // intentional relaxation for speed. Being in a meeting implies Teams is running, so
                // assert that invariant here regardless of whether the top-level walk above
                // succeeded (it can transiently fail while the cached HWND still resolves).
                snap.in_meeting = true;
                snap.teams_running = true;
                snap.window = Some(WindowInfo {
                    pid: m.get_process_id().unwrap_or(0),
                    name: m.get_name().unwrap_or_default(),
                });
                snap.signals.mute = label_signal(&mic, map_mute);
                // Prefer the OS webcam privacy signal (language-independent); fall back to the
                // localised video-button label only when the per-app record is unavailable.
                snap.signals.camera = match teams_webcam_in_use() {
                    Some(on) => known(on, "os-webcam"),
                    None => match cached_name(automation, cache, &m, "video-button") {
                        Some(n) => label_signal(&n, map_camera),
                        None => Signal::unknown(),
                    },
                };
                // hand: under the React flyout -- not passively readable (left flyout-only/unknown).
                snap.signals.sharing = known(sharing, "uia-window");
            }
            None => cache.rebind(None),
        }
    }

    snap
}

/// Resolves the active meeting window, preferring the cached HWND (one `ElementFromHandle` plus a
/// cheap classname check, ~sub-ms vs the full enumeration) and otherwise re-finding it from scratch
/// (the strict microphone+hangup match). Callers confirm it is still a live meeting via their own
/// control reads (the snapshot's mic read, a command's button lookup), so no separate probe is run
/// here. Updates `cache`, clearing it when the cached window is gone or no longer a TeamsWebView.
///
/// The cache is only ever seeded by `find_meeting_window`, so it can bind to the wrong window only if
/// the OS recycles the meeting's HWND onto another *live* TeamsWebView meeting -- which needs HWND
/// reuse plus concurrent meetings, out of scope under the single-meeting assumption. The common
/// recycle (onto the main Teams window, which has no microphone-button) self-heals: the caller's mic
/// read fails and clears the cache.
fn locate_meeting(automation: &UIAutomation, cache: &mut MeetingCache) -> Option<UIElement> {
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
    let m = find_meeting_window(automation)?;
    cache.rebind(m.get_native_window_handle().ok().map(|h| h.into()));
    Some(m)
}

/// Whether a top-level window is an active Teams meeting: a TeamsWebView that contains both the
/// microphone and hangup buttons.
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

fn find_first_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<UIElement> {
    let cond = automation
        .create_property_condition(UIProperty::AutomationId, Variant::from(aid), None)
        .ok()?;
    parent.find_first(TreeScope::Descendants, &cond).ok()
}

fn invoke_element(el: &UIElement) -> bool {
    matches!(el.get_pattern::<UIInvokePattern>(), Ok(p) if p.invoke().is_ok())
}

/// Actuates a control with the fast, focus-free MSAA default action (`accDoDefaultAction`, ~0.3ms
/// and provider-level). Falls back to `UIInvokePattern::invoke` (which blocks ~2s on Teams' Chromium
/// control) only when the Legacy pattern is unavailable. The foreground is captured before and
/// restored only if the actuation actually moved it -- so the common DoDefaultAction path pays no
/// focus dance, while the Invoke fallback (which briefly foregrounds Teams) is still corrected, and
/// the behaviour is invariant of which path runs.
fn actuate(el: &UIElement) -> bool {
    let prev = unsafe { GetForegroundWindow() };
    let ok = if let Ok(p) = el.get_pattern::<UILegacyIAccessiblePattern>() {
        p.do_default_action().is_ok() || invoke_element(el)
    } else {
        invoke_element(el)
    };
    if unsafe { GetForegroundWindow() } != prev {
        restore_foreground(prev);
    }
    ok
}

/// Runs a flyout action (raise-hand / reaction) off the serve loop, on a short-lived worker with its
/// OWN `UIAutomation`. The worker registers NO UIA event handlers (only the main thread mutates
/// handlers -- a UI Automation threading requirement), so `expand()` -- which has been seen to block
/// up to ~2s on some Teams builds -- can never freeze the snapshot stream. Resolves the meeting from
/// the cached HWND (falling back to a fresh search) and returns whether the inner item actuated.
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

/// Opens the React flyout, actuates the item by AutomationId with the fast MSAA default action, then
/// closes the flyout deterministically. Saves/restores the foreground (the Invoke fallback inside
/// `actuate` can briefly foreground Teams).
fn run_flyout(automation: &UIAutomation, meeting: &UIElement, aid: &str) -> bool {
    let Some(react) = find_first_id(automation, meeting, "reaction-menu-button") else {
        return false;
    };
    let prev = unsafe { GetForegroundWindow() };
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
    if unsafe { GetForegroundWindow() } != prev {
        restore_foreground(prev);
    }
    ok
}

/// Closes the React flyout so the next command never lands on an open menu (a left-open flyout makes
/// `microphone-button`/`hangup-button` transiently leave the tree and breaks meeting detection).
/// `collapse()` can report `Err` even when it succeeds, so the close is verified via
/// `ExpandCollapseState`; only a confirmed-still-`Expanded` menu is toggled shut via the React button
/// (re-invoking an already-closed menu would re-open it). Finally waits up to ~500ms for the control
/// bar (`microphone-button`) to return, so the command never returns while the flyout still disrupts
/// the tree. (The exact close mechanism is pending solo-meeting verification; the mic-reappear wait is
/// the backstop that holds regardless.)
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

/// Restores `prev` as the foreground window (the Invoke fallback briefly activates Teams).
fn restore_foreground(prev: HWND) {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut pid));
        let cur = GetCurrentThreadId();
        // AttachThreadInput(cur, cur, ...) is invalid, so skip the attach when the helper itself is
        // the foreground thread (only possible on a manual run, never for the plugin's spawned child).
        let attach = fg_thread != cur;
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, true);
        }
        let _ = SetForegroundWindow(prev);
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, false);
        }
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

/// What a command verb maps to, decided WITHOUT touching UIA so it is unit-testable. The
/// no-double-actuate guarantee rests on this: `Noop` never actuates and never triggers a stale-cache
/// retry, while `Toggle`/`Flyout` carry the exact AutomationId to act on.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Actuate a single control by AutomationId (mute / camera / leave).
    Toggle(&'static str),
    /// Open the React flyout and actuate an item by AutomationId (raise-hand / reactions).
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
        "raise-hand" => Action::Flyout("raisehands-button"),
        "react" => match arg.and_then(react_id) {
            Some(id) => Action::Flyout(id),
            None => Action::Noop,
        },
        _ => Action::Noop,
    }
}

/// Actuates a single toggle control (mute / camera / leave) on the cached meeting window, re-finding
/// the meeting once if the control is absent (stale cache after a rejoin or control-bar rebuild) so a
/// key press is never silently dropped. Fast (DoDefaultAction ~0.3ms), so it runs inline on the serve
/// loop; only the flyout is offloaded to a worker.
fn act_toggle(automation: &UIAutomation, cache: &mut MeetingCache, aid: &'static str) -> bool {
    if let Some(m) = locate_meeting(automation, cache) {
        if let Some(el) = cached_elem(automation, cache, &m, aid) {
            let ok = actuate(&el);
            // A cached element that validated yet still failed to actuate is suspect: drop it so the
            // NEXT press re-finds a fresh one. Deliberately do not retry within this call -- `actuate`
            // can report false after a real side effect (its `invoke` fallback), and a retry could
            // double-toggle. The 1s tick / next snapshot also re-warms the cache.
            if !ok {
                cache.drop_elem(aid);
            }
            return ok;
        }
    }
    // The control was absent from the (possibly stale) cached window: drop the window cache and retry
    // once against a freshly-found meeting, so a rejoin or HWND change never silently drops a press.
    cache.rebind(None);
    match locate_meeting(automation, cache) {
        Some(m) => cached_elem(automation, cache, &m, aid)
            .map(|el| actuate(&el))
            .unwrap_or(false),
        None => false,
    }
}

/// Messages the serve loop multiplexes: a command line from stdin, a "state may have changed" ping
/// from a UIA event handler, and a result line a flyout worker funnels back (so the main thread stays
/// the sole stdout writer).
enum Msg {
    Cmd(String),
    Ping,
    Result(String),
    /// stdin reached EOF (the parent closed it / exited): the loop exits so the helper never outlives
    /// its parent. Needed because the UIA handlers now hold `Sender` clones, so stdin EOF alone no
    /// longer disconnects the channel.
    Eof,
}

// Handler closures capture a `Sender<Msg>` and run on concurrent MTA callback threads, but the crate
// stores them as `Box<dyn Fn>` with no Send/Sync bound, so this invariant is unchecked at the
// registration sites. Lock it here: a future capture of a `!Sync` value (an `Rc`, `Cell`, a
// `UIElement`, ...) into a handler then breaks the build instead of becoming silent data-race UB.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Sender<Msg>>();
};

/// A live subtree `PropertyChanged(Name)` registration bound to a specific meeting window. Held on the
/// main thread (the handler and element are `!Send`) for the window's lifetime and removed by identity
/// when the window changes -- so re-registration never disturbs the long-lived root window handlers.
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

/// Registers the root-scoped window open/close handlers -- latency shorteners for Teams start/stop,
/// meeting join/leave and the sharing bar. Registered once for the serve lifetime; the returned
/// wrappers and root element must be kept alive while serving. Opens are filtered (by cached
/// class/name) to the windows we care about so unrelated desktop windows don't each nudge a rebuild;
/// closes always ping (a closing window's cache may be empty and a meeting-end must not be missed --
/// worst case the 1s tick catches it anyway). Handlers only `tx.send`; they never touch UIA further.
fn register_window_handlers(
    automation: &UIAutomation,
    tx: &Sender<Msg>,
) -> Option<(UIEventHandler, UIEventHandler, UIElement)> {
    let root = automation.get_root_element().ok()?;
    let req = automation.create_cache_request().ok()?;
    req.add_property(UIProperty::ClassName).ok()?;
    req.add_property(UIProperty::Name).ok()?;
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
            // A closing window's cached classname can be empty, so ping then too (it may be the
            // meeting / sharing window); otherwise only the windows we track, so unrelated desktop
            // closes don't nudge a rebuild.
            let cls = e.get_cached_classname().unwrap_or_default();
            let name = e.get_cached_name().unwrap_or_default();
            if cls.is_empty() || cls == "TeamsWebView" || name.starts_with("Sharing control bar") {
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

/// Registers a subtree `PropertyChanged(Name)` handler on the meeting window `hwnd`. A cache request
/// prefetches AutomationId so the handler filters to mic/video via `get_cached_automation_id()`
/// with no UIA round-trip per event (a live read per Name change would itself be the firehose). The
/// handler does nothing but ping -- it never touches UIA further nor moves a `!Send` value off-thread.
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
            if aid == "microphone-button" || aid == "video-button" {
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

/// Keeps the meeting-bound Name handler attached to the live meeting window, decoupled from the
/// per-snapshot `inMeeting` state: it (re)binds when the window changes and tears down only when the
/// window is gone -- crucially NOT when the control bar merely auto-hides (the window survives, so the
/// handler is kept and fires the moment the bar's mic button returns). Targeted removal leaves the
/// long-lived root window handlers untouched.
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
    // Short-circuit on HWND identity. Two tick-covered edges are accepted here: an OS HWND reuse onto
    // a *new* live meeting would skip the rebind (out of scope, same as `locate_meeting`'s cache), and
    // an in_meeting tick where `get_native_window_handle` failed (cache None) binds no handler that
    // tick; both self-heal on a later tick.
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

/// Builds the `{"type":"result",...}` line for a command. Reused by the inline toggle path and the
/// flyout worker so the wire result contract has a single source of truth (keys serialise sorted).
fn result_line(verb: &str, arg: Option<&str>, ok: bool) -> String {
    serde_json::json!({ "type": "result", "cmd": verb, "arg": arg, "ok": ok }).to_string()
}

/// Builds and emits one snapshot line, then reconciles the meeting-bound Name handler against the
/// freshly-resolved window. Returns false only when the stdout pipe is broken (parent gone).
fn emit_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    name_reg: &mut Option<NameReg>,
    tx: &Sender<Msg>,
) -> bool {
    let snap = build_snapshot(automation, cache);
    reconcile_name_handler(automation, name_reg, cache.hwnd, snap.in_meeting, tx);
    match serde_json::to_value(&snap) {
        Ok(mut v) => {
            v["type"] = serde_json::json!("snapshot");
            emit_line(&v.to_string())
        }
        Err(_) => true,
    }
}

/// Whether the loop should emit now: a snapshot is pending (`dirty`) and the debounce has elapsed.
fn should_emit(dirty: bool, since_emit: Duration, debounce: Duration) -> bool {
    dirty && since_emit >= debounce
}

/// How long the loop waits for the next message: while a snapshot is pending, only the remaining
/// debounce (so a pending emit can't oversleep); otherwise the full idle tick.
fn loop_wait(dirty: bool, since_emit: Duration, debounce: Duration, tick: Duration) -> Duration {
    if dirty {
        debounce.saturating_sub(since_emit)
    } else {
        tick
    }
}

/// Persistent service: streams snapshot JSON (`{"type":"snapshot",...}`) and command results
/// (`{"type":"result",...}`) on stdout, and reads command JSON on stdin. State reads are
/// event-driven -- a subtree `PropertyChanged(Name)` handler (mic/video) plus root window open/close
/// handlers ping the loop so a change shows in ~70-100ms -- layered over a slow ~1s safety tick that
/// bounds worst-case staleness and self-heals any missed/never-fired event (the plugin has no
/// snapshot watchdog). Snapshots are debounced to at most one per ~150ms so an event or window burst
/// (e.g. the control-bar rebuild) cannot saturate the loop. Exits when stdin closes (channel
/// disconnects) or the stdout pipe breaks, so it never outlives the plugin that spawned it.
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
                    // A closed Windows pipe yields a repeating read error (not a clean EOF), so stop
                    // on it; only a non-UTF-8 line is skipped (preserving the shipped invalid-line
                    // tolerance) -- a blanket `continue` would busy-loop on a broken pipe.
                    Err(e) if e.kind() == ErrorKind::InvalidData => continue,
                    Err(_) => break,
                }
            }
            // stdin EOF (parent closed it / exited): tell the loop to exit. A dropped `tx` alone no
            // longer disconnects the channel (the UIA handlers hold their own clones).
            let _ = tx.send(Msg::Eof);
        });
    }

    // HWND of the active meeting window plus its cached control elements (see `MeetingCache`).
    let mut cache = MeetingCache::new();
    // The meeting-bound Name handler, rebound as the meeting window changes.
    let mut name_reg: Option<NameReg> = None;
    // Long-lived root window handlers (latency shorteners); kept alive for the serve lifetime. On
    // failure the loop still runs on the 1s tick + Name handler, but surface it for the plugin log.
    let window_reg = register_window_handlers(automation, &tx);
    if window_reg.is_none() {
        eprintln!("teamdeck-helper: window event handlers failed to register; relying on the tick");
    }

    let debounce = Duration::from_millis(150);
    let tick = Duration::from_secs(1);
    // Start "dirty" with a back-dated last-emit so the first snapshot fires immediately.
    let mut dirty = true;
    let mut last_emit = Instant::now()
        .checked_sub(debounce)
        .unwrap_or_else(Instant::now);

    loop {
        if should_emit(dirty, last_emit.elapsed(), debounce) {
            if !emit_snapshot(automation, &mut cache, &mut name_reg, &tx) {
                break; // stdout pipe broken: parent gone.
            }
            last_emit = Instant::now();
            dirty = false;
        }
        let wait = loop_wait(dirty, last_emit.elapsed(), debounce, tick);
        match rx.recv_timeout(wait) {
            Ok(Msg::Cmd(line)) => match handle_command(automation, &mut cache, &line, &tx) {
                Handled::Stop => break, // stdout pipe broken: parent gone.
                // A flyout returns snapshot=false: its worker emits the post-settle snapshot via
                // Msg::Result, so the loop must not snapshot mid-rebuild (avoids an inMeeting flicker).
                Handled::Go { snapshot } => {
                    if snapshot {
                        dirty = true;
                    }
                }
            },
            Ok(Msg::Ping) => dirty = true,
            Ok(Msg::Result(line)) => {
                if !emit_line(&line) {
                    break;
                }
                dirty = true;
            }
            Ok(Msg::Eof) => break, // stdin closed: parent gone.
            // Timeout = the 1s safety tick, or the debounce window elapsing: resnapshot either way.
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
    /// Keep serving. `snapshot` requests an immediate post-command snapshot -- true for the inline
    /// toggle/no-op paths, false for a flyout (its worker emits its own snapshot once the control bar
    /// has settled, via `Msg::Result`, so the loop must not snapshot mid-rebuild).
    Go { snapshot: bool },
    /// The stdout pipe broke (parent gone): stop serving.
    Stop,
}

/// Parses one command line and acts. Toggles (mute/camera/leave) run inline (fast DoDefaultAction)
/// and emit their result immediately; flyout actions (raise-hand/reactions) run on a worker that
/// funnels its `{"type":"result",...}` back via `Msg::Result`, so the main thread stays the sole
/// stdout writer and a slow `expand()` never freezes the stream.
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

    // Read mode (used by the CI and release smoke tests): emit one snapshot and exit.
    let snap = build_snapshot(&automation, &mut MeetingCache::new());
    println!("{}", serde_json::to_string(&snap).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_mute_reads_the_action_verb() {
        assert_eq!(map_mute("Unmute mic"), Some(true), "Unmute => muted");
        assert_eq!(map_mute("Mute mic"), Some(false), "Mute => unmuted");
        assert_eq!(map_mute("Microphone"), None);
    }

    #[test]
    fn label_matching_is_case_insensitive_and_order_aware() {
        // The seam matches case-insensitively, so a localised label in any casing still resolves.
        assert_eq!(map_mute("UNMUTE MIC"), Some(true));
        assert_eq!(map_mute("unmute mic"), Some(true));
        // "unmute" contains "mute": the more specific needle must win, never collapse to unmuted.
        assert_eq!(
            map_mute("Unmute"),
            Some(true),
            "must not match the 'mute' needle first"
        );
        assert_eq!(map_camera("turn camera on"), Some(false));
    }

    #[test]
    fn map_camera_is_case_insensitive() {
        assert_eq!(
            map_camera("Turn camera off"),
            Some(true),
            "off label => camera on"
        );
        assert_eq!(map_camera("TURN CAMERA OFF"), Some(true));
        assert_eq!(
            map_camera("Turn camera on"),
            Some(false),
            "on label => camera off"
        );
        assert_eq!(map_camera("No control here"), None);
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
            Action::Flyout("raisehands-button")
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
}
