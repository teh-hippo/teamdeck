use std::time::Duration;
use uiautomation::patterns::{UIExpandCollapsePattern, UILegacyIAccessiblePattern};
use uiautomation::types::{ExpandCollapseState, Handle, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

fn has_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    find_first_id(automation, parent, aid).is_some()
}

/// Cache request prefetching ClassName+Name so the top-level walk reads them locally (no per-window round-trip).
pub(crate) fn top_cache_request(
    automation: &UIAutomation,
) -> uiautomation::Result<uiautomation::core::UICacheRequest> {
    let req = automation.create_cache_request()?;
    req.add_property(UIProperty::ClassName)?;
    req.add_property(UIProperty::Name)?;
    Ok(req)
}

/// Caches the meeting HWND and its control elements (mic/camera/hangup) for reads and toggles; entries are validated live on use and cleared on HWND change.
pub(crate) struct MeetingCache {
    pub(crate) hwnd: Option<isize>,
    elems: Vec<(&'static str, UIElement)>,
}

impl MeetingCache {
    pub(crate) fn new() -> Self {
        MeetingCache {
            hwnd: None,
            elems: Vec::new(),
        }
    }

    /// Points the cache at `hwnd`, clearing cached elements when the window changes.
    pub(crate) fn rebind(&mut self, hwnd: Option<isize>) {
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

    pub(crate) fn drop_elem(&mut self, aid: &str) {
        self.elems.retain(|(a, _)| *a != aid);
    }
}

/// The control element for `aid`: a cached element re-validated by a live AutomationId read (dropped + re-found if stale), else found and cached. None if absent.
pub(crate) fn cached_elem(
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
pub(crate) fn cached_name(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    meeting: &UIElement,
    aid: &'static str,
) -> Option<String> {
    cached_elem(automation, cache, meeting, aid)?
        .get_name()
        .ok()
}

/// Resolves the meeting window, preferring the cached HWND over a scan of the caller's `TeamsWebView` candidates (no second enumeration). Clears the cache when the cached window is gone or not a `TeamsWebView`; a wrong-window bind self-heals via the caller's mic read.
pub(crate) fn locate_meeting(
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
pub(crate) fn top_teamswebviews(automation: &UIAutomation) -> Vec<UIElement> {
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
pub(crate) fn actuate(el: &UIElement) -> bool {
    matches!(el.get_pattern::<UILegacyIAccessiblePattern>(), Ok(p) if p.do_default_action().is_ok())
}

/// Runs a flyout action on a short-lived worker (own `UIAutomation`, no event handlers) so a slow `expand()` can't freeze the snapshot stream. Resolves the meeting from the cached HWND.
pub(crate) fn run_flyout_worker(hwnd: Option<isize>, aid: &str) -> bool {
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
    // The flyout DOM builds lazily (~95ms in the live spike); poll for the item up to ~750ms, trying immediately first (the menu may already be open from a prior action).
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

pub(crate) fn react_id(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "like" => "like-button",
        "love" => "heart-button",
        "laugh" => "laugh-button",
        "surprised" => "surprised-button",
        "applause" => "applause-button",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn meeting_cache_rebind_tracks_hwnd_and_is_idempotent() {
        // A UIElement is a COM wrapper (the element paths are live-only), so this locks the pure HWND state machine: empty on new, idempotent rebind, re-point on any window change.
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
}
