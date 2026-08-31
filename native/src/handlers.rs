use crate::meeting::top_cache_request;
use crate::serve::Msg;
use std::sync::mpsc::Sender;
use uiautomation::events::{
    CustomEventHandlerFn, CustomPropertyChangedEventHandlerFn, UIEventHandler, UIEventType,
    UIPropertyChangedEventHandler,
};
use uiautomation::types::{Handle, TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement};

/// A live subtree PropertyChanged(Name) registration bound to one meeting window; removed by identity when the window changes.
pub(crate) struct NameReg {
    handler: UIPropertyChangedEventHandler,
    window: UIElement,
    hwnd: isize,
}

pub(crate) type WindowReg = (UIEventHandler, UIEventHandler, UIElement);

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
pub(crate) fn register_window_handlers(
    automation: &UIAutomation,
    tx: &Sender<Msg>,
    retired: &mut Vec<WindowReg>,
) -> Option<WindowReg> {
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
            // Ping only when a tracked window closes; transient WebView2 children close with an empty ClassName (ignored, else every tooltip/popup close would ping), and a leave that arrives empty is reconciled by the in-meeting backstop tick.
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
    if automation
        .add_automation_event_handler(
            UIEventType::Window_WindowClosed,
            &root,
            TreeScope::Subtree,
            Some(&req),
            &closed,
        )
        .is_err()
    {
        let _ = automation.remove_automation_event_handler(
            UIEventType::Window_WindowOpened,
            &root,
            &opened,
        );
        retired.push((opened, closed, root));
        return None;
    }
    Some((opened, closed, root))
}

pub(crate) fn reconcile_window_handlers(
    automation: &UIAutomation,
    registration: &mut Option<WindowReg>,
    retired: &mut Vec<WindowReg>,
    attempts: &mut u8,
    tx: &Sender<Msg>,
) -> bool {
    if registration.is_some() || *attempts >= 3 {
        return false;
    }
    *attempts += 1;
    *registration = register_window_handlers(automation, tx, retired);
    registration.is_none() && *attempts == 3
}

/// Subtree state-change handler on the meeting window.
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
            &[
                UIProperty::Name,
                UIProperty::FullDescription,
                UIProperty::AriaProperties,
                UIProperty::ToggleToggleState,
                UIProperty::LegacyIAccessibleState,
            ],
        )
        .ok()?;
    Some(NameReg {
        handler,
        window,
        hwnd,
    })
}

/// Keeps the Name handler bound to the live meeting window, decoupled from `inMeeting`: rebinds on window change, tears down only when the window is gone (not when the control bar auto-hides).
pub(crate) fn reconcile_name_handler(
    automation: &UIAutomation,
    name_reg: &mut Option<NameReg>,
    retired: &mut Vec<NameReg>,
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
    if name_reg.as_ref().map(|registration| registration.hwnd) == desired {
        return;
    }
    if let Some(reg) = name_reg.take() {
        let _ = automation.remove_property_changed_event_handler(&reg.window, &reg.handler);
        retired.push(reg);
        if retired.len() > 8 {
            retired.remove(0);
        }
    }
    if let Some(h) = desired {
        *name_reg = register_name_handler(automation, h, tx.clone());
    }
}
