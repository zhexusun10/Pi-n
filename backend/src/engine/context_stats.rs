//! Request Pi's projected context without making another model call. The RPC
//! response is reduced to counters before it enters the durable output log.
use serde_json::{json, Value};
use std::sync::mpsc;

const CONTEXT_STATS_ID_PREFIX: &str = "pi-n-ctx-stats-";

pub(super) struct ContextStats {
    enabled: bool,
    pending: Option<String>,
    dirty: bool,
    /// Set once a message/compaction/model event has already triggered a stats
    /// request in the current turn so an immediately following `turn_end` or
    /// `agent_settled` does not queue a redundant identical RPC.
    requested_in_turn: bool,
    last_emitted: Option<(Value, Value)>,
}

impl ContextStats {
    pub(super) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            pending: None,
            dirty: false,
            requested_in_turn: false,
            last_emitted: None,
        }
    }

    /// Coalesce bursts of message/tool boundaries into at most one outstanding
    /// request, followed by one fresh reading if the session changed meanwhile.
    pub(super) fn changed(&mut self, sender: Option<&mpsc::Sender<String>>) {
        if !self.enabled {
            return;
        }
        if self.pending.is_some() {
            self.dirty = true;
            return;
        }
        let id = format!("{CONTEXT_STATS_ID_PREFIX}{}", uuid::Uuid::new_v4());
        let request = json!({"id": id, "type": "get_session_stats"}).to_string();
        if sender.is_some_and(|sender| sender.send(request).is_ok()) {
            self.pending = Some(id);
        } else {
            self.enabled = false;
        }
    }

    pub(super) fn waiting(&self) -> bool {
        self.pending.is_some()
    }

    /// `Some` identifies our response; the nested option is absent on failure
    /// or when `(tokens, window)` is unchanged since the last emitted snapshot.
    pub(super) fn response(
        &mut self,
        event: &Value,
        sender: Option<&mpsc::Sender<String>>,
    ) -> Option<Option<Value>> {
        if event["type"] != "response" {
            return None;
        }
        let response_id = event["id"].as_str();
        if response_id != self.pending.as_deref() || self.pending.is_none() {
            // A late response from a previous parked Serial turn's own
            // ContextStats request must not leak its full statistics into the
            // next attempt's output log, while composer `/stats` and `/session`
            // requests (which do not use our prefix) must reach `rpc_pending`.
            return (event["command"] == "get_session_stats"
                && response_id.is_some_and(|id| id.starts_with(CONTEXT_STATS_ID_PREFIX)))
            .then_some(None);
        }
        self.pending = None;
        if event["success"] != true || event["command"] != "get_session_stats" {
            // An older/failed RPC implementation must not affect execution.
            self.enabled = false;
            self.dirty = false;
            return Some(None);
        }
        let usage = &event["data"]["contextUsage"];
        let pair = (usage["tokens"].clone(), usage["contextWindow"].clone());
        let result = if self.last_emitted.as_ref() == Some(&pair) {
            None
        } else {
            self.last_emitted = Some(pair);
            Some(json!({
                "type": "pi_n_context_usage",
                "tokens": usage["tokens"],
                "window": usage["contextWindow"],
            }))
        };
        if std::mem::take(&mut self.dirty) {
            self.changed(sender);
        }
        Some(result)
    }

    pub(super) fn observe(&mut self, event: &Value, sender: Option<&mpsc::Sender<String>>) {
        match event["type"].as_str() {
            Some("agent_start" | "turn_start" | "message_start") => {
                self.requested_in_turn = false;
            }
            Some("message_end" | "compaction_end" | "model_change") => {
                self.requested_in_turn = true;
                self.changed(sender);
            }
            Some("entry_appended")
                if matches!(
                    event["entry"]["type"].as_str(),
                    Some("context_edit" | "compaction")
                ) =>
            {
                self.requested_in_turn = true;
                self.changed(sender);
            }
            Some("turn_end" | "agent_settled") => {
                if !self.requested_in_turn {
                    self.requested_in_turn = true;
                    self.changed(sender);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats_response(id: &str, tokens: u64, window: u64) -> Value {
        json!({
            "type": "response",
            "id": id,
            "command": "get_session_stats",
            "success": true,
            "data": {
                "contextUsage": {
                    "tokens": tokens,
                    "contextWindow": window,
                }
            }
        })
    }

    #[test]
    fn turn_end_after_message_end_does_not_queue_duplicate_stats_request() {
        let (tx, rx) = mpsc::channel();
        let mut stats = ContextStats::new(true);
        stats.observe(&json!({"type": "turn_start"}), Some(&tx));
        stats.observe(&json!({"type": "message_end"}), Some(&tx));
        stats.observe(&json!({"type": "turn_end"}), Some(&tx));

        let first_req: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let first_id = first_req["id"].as_str().unwrap().to_string();
        assert!(rx.try_recv().is_err(), "no second request while pending");

        let emitted = stats
            .response(&stats_response(&first_id, 1000, 512000), Some(&tx))
            .unwrap()
            .unwrap();
        assert_eq!(emitted["tokens"], 1000);
        assert_eq!(emitted["window"], 512000);
        assert!(
            rx.try_recv().is_err(),
            "turn_end right after message_end must not mark dirty and fire a second RPC"
        );
    }

    #[test]
    fn unchanged_context_usage_is_deduplicated_while_changes_emit() {
        let (tx, rx) = mpsc::channel();
        let mut stats = ContextStats::new(true);

        stats.changed(Some(&tx));
        let req1: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let first = stats
            .response(&stats_response(req1["id"].as_str().unwrap(), 500, 128000), Some(&tx))
            .unwrap();
        assert!(first.is_some());

        // Identical values on a subsequent fetch are suppressed.
        stats.changed(Some(&tx));
        let req2: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let dup = stats
            .response(&stats_response(req2["id"].as_str().unwrap(), 500, 128000), Some(&tx))
            .unwrap();
        assert!(dup.is_none());

        // Changed values emit normally.
        stats.changed(Some(&tx));
        let req3: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let updated = stats
            .response(&stats_response(req3["id"].as_str().unwrap(), 750, 128000), Some(&tx))
            .unwrap()
            .unwrap();
        assert_eq!(updated["tokens"], 750);
    }
}
