//! TeamDeck native helper.
//!
//! Reads Microsoft Teams meeting state via Windows UI Automation and actuates the meeting controls.
//! Emits the snapshot contract as one JSON object per line on stdout.

mod command;
mod handlers;
mod labels;
mod meeting;
mod presence;
mod serve;
mod snapshot;

use meeting::MeetingCache;
use serve::{build_snapshot, serve, start_heartbeat_writer};
use snapshot::PresenceState;
use uiautomation::UIAutomation;

fn main() {
    let serve_mode = std::env::args().nth(1).as_deref() == Some("serve");
    if serve_mode {
        start_heartbeat_writer();
    }
    let automation = match UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("failed to init UIAutomation: {e}");
            std::process::exit(1);
        }
    };

    if serve_mode {
        serve(&automation);
        return;
    }

    // Read mode (used by the CI and release smoke tests): emit one snapshot and exit. Presence is opt-in and never read in one-shot mode, so it reports disabled.
    let snap = build_snapshot(
        &automation,
        &mut MeetingCache::new(),
        &PresenceState::disabled(),
    );
    println!("{}", serde_json::to_string(&snap).unwrap());
}
