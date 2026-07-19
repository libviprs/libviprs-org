//! extract-cli-snippets — SCHEMA v2
//!
//! Reads the annotated Rust CLI source (`cli/rust/main.rs` plus every
//! `cli/rust/ops/*.rs`) and emits a **command-scoped** JSON snippet manifest
//! (`cli/js/snippets.generated.json`) consumed by the interactive doc page and
//! the per-flag audit.
//!
//! See `cli/SCHEMA_V2.md` for the frozen grammar and JSON shape. In brief:
//!
//! * Everything is keyed by `(command, id)` — the v1 flat global slot/flag maps
//!   (where `test-image --width` and `black --width` would collide) are gone.
//! * A command's `slot_order` / `imports_base` come from its `@doc-command`
//!   block; the built-in `pyramid` command falls back to `PYRAMID_BASELINE`.
//! * `pyramid` is the one **interactive**, hand-authored command. Its manifest
//!   object is authoritative and embedded verbatim (`pyramid.command.json`), so
//!   the live generator's rich `default`/`type`/`cli`/`options` fields — which
//!   are not expressible in the source annotations — survive regeneration
//!   byte-for-byte. `assert_pyramid_baseline()` guards it against drift.
//! * Op families (e.g. a future `cli/rust/ops/morphology.rs`) are parsed from
//!   their annotations and merged in, command-scoped.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::{json, Map, Value};

// -------- canonical constants (version 2) --------

const VERSION: u32 = 2;

/// The frozen `pyramid` baseline (SCHEMA_V2 §4.1). Doubles as:
///   1. the PYRAMID **fallback** (§1.4) — an un-annotated `pyramid` source still
///      yields this `slot_order`/`imports_base`; and
///   2. the regression guard checked by [`assert_pyramid_baseline`] (§4.2).
struct PyramidBaseline {
    slot_order: &'static [&'static str],
    imports_base: &'static [&'static str],
    flag_ids: &'static [&'static str],
}

const PYRAMID_BASELINE: PyramidBaseline = PyramidBaseline {
    // 9 slots, in order.
    slot_order: &[
        "tracing-init",
        "load-source",
        "planner",
        "memory-limit",
        "geo",
        "sink",
        "engine-config",
        "engine-builder",
        "finish",
    ],
    // 7 symbols.
    imports_base: &[
        "EngineBuilder",
        "EngineConfig",
        "FsSink",
        "Layout",
        "PyramidPlanner",
        "TileFormat",
        "decode_file",
    ],
    // 31 flag ids that MUST be present.
    flag_ids: &[
        "blank-tolerance",
        "buffer-size",
        "centre",
        "checksum-algo",
        "concurrency",
        "dedupe-all",
        "dedupe-blanks",
        "dpi",
        "failure-policy",
        "format",
        "geo-origin",
        "geo-scale",
        "layout",
        "manifest-emit-checksums",
        "match-page-size",
        "memory-budget",
        "memory-limit",
        "overlap",
        "overwrite",
        "page",
        "parallel",
        "quality",
        "render",
        "resume",
        "retry-backoff",
        "retry-max",
        "sink",
        "skip-blank",
        "tile-size",
        "trace-level",
        "verify",
    ],
};

const DEFAULT_COMMAND: &str = "pyramid";

/// The hand-authored, interactive `pyramid` command object, embedded verbatim.
/// It is the authoritative source for `commands.pyramid` (see module docs).
const PYRAMID_COMMAND_JSON: &str = include_str!("../pyramid.command.json");

// -------- data structures (parsed op families) --------

#[derive(Debug, Default, Serialize)]
struct Slot {
    imports_when_active: Vec<String>,
    lines: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    gated_by: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Flag {
    slot: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    param_name: Option<String>,
    fragment: String,
    imports_when_active: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    special: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    test: Option<TestRef>,
}

#[derive(Debug, Serialize)]
struct TestRef {
    file: String,
    #[serde(rename = "fn")]
    fn_name: String,
    line: u64,
    repo: String,
}

/// A single command's parsed contribution. `pyramid` from `main.rs` is parsed
/// like any other but is later superseded by the embedded authoritative object.
#[derive(Debug, Default)]
struct Command {
    about: Option<String>,
    /// Whether a `@doc-command` block was seen for this command.
    has_header: bool,
    imports_base: Vec<String>,
    slot_order: Vec<String>,
    slots: BTreeMap<String, Slot>,
    flags: BTreeMap<String, Flag>,
}

#[derive(Serialize)]
struct CommandOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    about: Option<String>,
    interactive: bool,
    imports_base: Vec<String>,
    slot_order: Vec<String>,
    slots: BTreeMap<String, Value>,
    flags: BTreeMap<String, Value>,
}

// -------- main --------

fn main() -> ExitCode {
    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    let rust_dir = manifest_dir.join("../../rust");
    let output_path = manifest_dir.join("../../js/snippets.generated.json");

    // Multi-file input: main.rs first, then every ops/*.rs (glob, sorted).
    let mut sources: Vec<(PathBuf, String)> = Vec::new();
    read_source_into(&rust_dir.join("main.rs"), &mut sources);
    for path in glob_ops_rs(&rust_dir.join("ops")) {
        read_source_into(&path, &mut sources);
    }

    let mut commands: BTreeMap<String, Command> = BTreeMap::new();
    for (_path, source) in &sources {
        merge_commands(&mut commands, parse(source));
    }

    if commands.is_empty() {
        eprintln!(
            "extract-cli-snippets: no commands parsed from any input under {} — refusing to write an empty manifest",
            rust_dir.display()
        );
        return ExitCode::from(1);
    }

    let manifest = match build_manifest(commands) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("extract-cli-snippets: {e}");
            return ExitCode::from(1);
        }
    };

    let pretty = match serde_json::to_string_pretty(&manifest) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("extract-cli-snippets: failed to serialise manifest: {e}");
            return ExitCode::from(1);
        }
    };

    if let Some(parent) = output_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "extract-cli-snippets: failed to create output dir {}: {}",
                parent.display(),
                e
            );
            return ExitCode::from(1);
        }
    }

    if let Err(e) = fs::write(&output_path, format!("{pretty}\n")) {
        eprintln!(
            "extract-cli-snippets: failed to write {}: {}",
            output_path.display(),
            e
        );
        return ExitCode::from(1);
    }

    let (n_cmds, n_flags, n_slots) = manifest_stats(&manifest);
    println!("wrote {n_cmds} commands, {n_flags} flags across {n_slots} slots");
    ExitCode::from(0)
}

fn read_source_into(path: &std::path::Path, out: &mut Vec<(PathBuf, String)>) {
    match fs::read_to_string(path) {
        Ok(s) => out.push((path.to_path_buf(), s)),
        Err(e) => {
            // Per-file tolerance: warn and continue (the empty-map guard in
            // main() is the hard error).
            eprintln!(
                "extract-cli-snippets: input not readable ({}): {} — skipping",
                path.display(),
                e
            );
        }
    }
}

fn glob_ops_rs(ops_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(ops_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn manifest_stats(manifest: &Value) -> (usize, usize, usize) {
    let commands = manifest
        .get("commands")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut flags = 0;
    let mut slots = 0;
    for (_name, cmd) in commands.iter() {
        flags += cmd
            .get("flags")
            .and_then(Value::as_object)
            .map(|o| o.len())
            .unwrap_or(0);
        slots += cmd
            .get("slots")
            .and_then(Value::as_object)
            .map(|o| o.len())
            .unwrap_or(0);
    }
    (commands.len(), flags, slots)
}

// -------- manifest assembly --------

fn build_manifest(parsed: BTreeMap<String, Command>) -> Result<Value, String> {
    // The authoritative, hand-authored pyramid command (interactive).
    let pyramid_value: Value = serde_json::from_str(PYRAMID_COMMAND_JSON)
        .map_err(|e| format!("embedded pyramid.command.json is not valid JSON: {e}"))?;

    let mut commands = Map::new();

    // Emit commands in sorted key order for deterministic bytes.
    let mut names: Vec<String> = parsed.keys().cloned().collect();
    if !names.iter().any(|n| n == DEFAULT_COMMAND) {
        names.push(DEFAULT_COMMAND.to_string());
    }
    names.sort();
    names.dedup();

    for name in &names {
        if name == DEFAULT_COMMAND {
            // Hand-authored interactive command supersedes any parsed pyramid.
            commands.insert(name.clone(), pyramid_value.clone());
            continue;
        }
        let cmd = parsed
            .get(name)
            .expect("name came from parsed keys or pyramid");
        commands.insert(name.clone(), command_out_value(name, cmd)?);
    }

    // Regression guard on the emitted pyramid (§4.2), before returning.
    let pyramid = commands
        .get(DEFAULT_COMMAND)
        .ok_or_else(|| "pyramid command absent from manifest".to_string())?;
    assert_pyramid_baseline(pyramid)?;

    let mut root = Map::new();
    root.insert("version".to_string(), json!(VERSION));
    root.insert("commands".to_string(), Value::Object(commands));
    Ok(Value::Object(root))
}

/// Resolve + validate a parsed (non-pyramid) command into its JSON object,
/// applying the §1.4 sourcing rules.
fn command_out_value(name: &str, cmd: &Command) -> Result<Value, String> {
    let has_content = !cmd.slots.is_empty() || !cmd.flags.is_empty();

    // A command with content but no @doc-command block is a hard error (§1.4).
    // (No header and no content emits an empty object, which never happens for a
    // command that got into the map via a snippet/flag.)
    if !cmd.has_header && has_content {
        return Err(format!(
            "command '{name}' has snippets but no @doc-command block declaring slot-order/imports-base"
        ));
    }

    // slot-order must list exactly the slot ids the command defines (§1.4).
    for slot_id in &cmd.slot_order {
        if !cmd.slots.contains_key(slot_id) {
            return Err(format!(
                "command '{name}': slot-order references slot '{slot_id}' that is never opened"
            ));
        }
    }
    for slot_id in cmd.slots.keys() {
        if !cmd.slot_order.contains(slot_id) {
            return Err(format!(
                "command '{name}': slot '{slot_id}' is opened but absent from slot-order"
            ));
        }
    }

    let mut slots = BTreeMap::new();
    for (id, slot) in &cmd.slots {
        slots.insert(id.clone(), serde_json::to_value(slot).unwrap());
    }
    let mut flags = BTreeMap::new();
    for (id, flag) in &cmd.flags {
        flags.insert(id.clone(), serde_json::to_value(flag).unwrap());
    }

    let out = CommandOut {
        about: cmd.about.clone(),
        interactive: false,
        imports_base: cmd.imports_base.clone(),
        slot_order: cmd.slot_order.clone(),
        slots,
        flags,
    };
    Ok(serde_json::to_value(out).unwrap())
}

/// Fail loud (SCHEMA_V2 §4.2) if the emitted pyramid regresses from baseline.
fn assert_pyramid_baseline(pyramid: &Value) -> Result<(), String> {
    let obj = pyramid
        .as_object()
        .ok_or_else(|| "pyramid command is not a JSON object".to_string())?;

    // slot_order.
    let slot_order = string_array(obj.get("slot_order"))
        .ok_or_else(|| "pyramid: slot_order missing or not an array of strings".to_string())?;
    let baseline_order: Vec<String> = PYRAMID_BASELINE
        .slot_order
        .iter()
        .map(|s| s.to_string())
        .collect();
    if slot_order != baseline_order {
        let missing = diff_missing(&baseline_order, &slot_order);
        let extra = diff_missing(&slot_order, &baseline_order);
        if missing.is_empty() && extra.is_empty() {
            return Err(format!(
                "pyramid regressed: slot_order reordered\n  expected: {baseline_order:?}\n  found:    {slot_order:?}"
            ));
        }
        return Err(format!(
            "pyramid regressed: slot_order drift (missing: {missing:?}, extra: {extra:?})"
        ));
    }

    // imports_base.
    let imports_base = string_array(obj.get("imports_base"))
        .ok_or_else(|| "pyramid: imports_base missing or not an array of strings".to_string())?;
    let baseline_imports: Vec<String> = PYRAMID_BASELINE
        .imports_base
        .iter()
        .map(|s| s.to_string())
        .collect();
    if imports_base != baseline_imports {
        let missing = diff_missing(&baseline_imports, &imports_base);
        let extra = diff_missing(&imports_base, &baseline_imports);
        return Err(format!(
            "pyramid regressed: imports_base drift (missing: {missing:?}, extra: {extra:?})"
        ));
    }

    // slots: exactly the 9 ids of slot_order must be present.
    let slots = obj
        .get("slots")
        .and_then(Value::as_object)
        .ok_or_else(|| "pyramid: slots missing or not an object".to_string())?;
    for id in &baseline_order {
        if !slots.contains_key(id) {
            return Err(format!("pyramid regressed: missing slot '{id}'"));
        }
    }
    if slots.len() != baseline_order.len() {
        return Err(format!(
            "pyramid regressed: slot count {} != baseline {}",
            slots.len(),
            baseline_order.len()
        ));
    }

    // flags: every baseline flag id must be present; count >= 31.
    let flags = obj
        .get("flags")
        .and_then(Value::as_object)
        .ok_or_else(|| "pyramid: flags missing or not an object".to_string())?;
    let missing_flags: Vec<&str> = PYRAMID_BASELINE
        .flag_ids
        .iter()
        .filter(|id| !flags.contains_key(**id))
        .copied()
        .collect();
    if !missing_flags.is_empty() {
        return Err(format!(
            "pyramid regressed: missing flags {missing_flags:?}"
        ));
    }
    if flags.len() < PYRAMID_BASELINE.flag_ids.len() {
        return Err(format!(
            "pyramid flag count {} < baseline {}",
            flags.len(),
            PYRAMID_BASELINE.flag_ids.len()
        ));
    }

    Ok(())
}

fn string_array(v: Option<&Value>) -> Option<Vec<String>> {
    let arr = v?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        out.push(item.as_str()?.to_string());
    }
    Some(out)
}

/// Items present in `full` but absent from `subset`.
fn diff_missing(full: &[String], subset: &[String]) -> Vec<String> {
    full.iter()
        .filter(|s| !subset.contains(s))
        .cloned()
        .collect()
}

// -------- merge --------

fn merge_commands(into: &mut BTreeMap<String, Command>, from: BTreeMap<String, Command>) {
    for (name, cmd) in from {
        let entry = into.entry(name).or_default();
        if cmd.has_header {
            entry.has_header = true;
            if cmd.about.is_some() {
                entry.about = cmd.about;
            }
            if !cmd.imports_base.is_empty() {
                entry.imports_base = cmd.imports_base;
            }
            if !cmd.slot_order.is_empty() {
                entry.slot_order = cmd.slot_order;
            }
        }
        for (id, slot) in cmd.slots {
            entry.slots.insert(id, slot);
        }
        for (id, flag) in cmd.flags {
            entry.flags.insert(id, flag);
        }
    }
}

// -------- parser --------

/// Parse one annotated source into a per-command map.
fn parse(source: &str) -> BTreeMap<String, Command> {
    let mut commands: BTreeMap<String, Command> = BTreeMap::new();

    // Active snippet stack: (command, slot).
    let mut stack: Vec<(String, String)> = Vec::new();

    // A pending @doc-test from a previous line that should attach to the next
    // @doc-flag.
    let mut pending_test: Option<TestRef> = None;

    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let raw_line = lines[i];

        // @doc-command block header (may span continuation lines ending in `\`).
        if find_marker(raw_line, "@doc-command:begin").is_some() {
            let (logical, consumed) = join_continuation(&lines, i);
            i += consumed;
            let tail = find_marker(&logical, "@doc-command:begin").unwrap_or_default();
            apply_command_header(&mut commands, &tail);
            continue;
        }
        if find_marker(raw_line, "@doc-command:end").is_some() {
            i += 1;
            continue;
        }

        if let Some(begin) = find_marker(raw_line, "@doc-snippet:begin") {
            let attrs = parse_attrs(begin);
            if let Some(slot_id) = attrs.get("slot").cloned() {
                let command = resolve_command(&attrs, &stack);
                let imports = attrs
                    .get("imports")
                    .map(|v| split_csv(v))
                    .unwrap_or_default();
                let entry = commands.entry(command.clone()).or_default();
                let slot = entry.slots.entry(slot_id.clone()).or_default();
                if !imports.is_empty() {
                    slot.imports_when_active = imports;
                }
                stack.push((command, slot_id));
            }
            i += 1;
            continue;
        }

        if let Some(end) = find_marker(raw_line, "@doc-snippet:end") {
            let attrs = parse_attrs(end);
            if let Some(slot_id) = attrs.get("slot") {
                if let Some(pos) = stack.iter().rposition(|(_, s)| s == slot_id) {
                    stack.remove(pos);
                }
            } else if !stack.is_empty() {
                stack.pop();
            }
            i += 1;
            continue;
        }

        // Non-marker line: @doc-test (sets pending) and/or @doc-flag.
        let mut line_test: Option<TestRef> = None;
        if let Some(test_tail) = find_marker(raw_line, "@doc-test:") {
            line_test = parse_test_ref(test_tail);
        }

        let mut flag_for_line: Option<(String, String, Flag)> = None;
        if let Some(flag_tail) = find_marker(raw_line, "@doc-flag:") {
            let fragment = strip_doc_annotations(raw_line);
            let attrs = parse_flag_attrs(flag_tail);
            if let Some((id, command, mut flag)) = parse_flag(&attrs, fragment, &stack) {
                let test = line_test.take().or_else(|| pending_test.take());
                flag.test = test;
                flag_for_line = Some((id, command, flag));
            }
        }

        if let Some(t) = line_test {
            pending_test = Some(t);
        }

        // Capture line into the active slot.
        if let Some((command, slot_id)) = stack.last().cloned() {
            let captured = strip_doc_annotations(raw_line);
            let is_pure_annotation = captured.trim().is_empty() && !raw_line.trim().is_empty();
            if !is_pure_annotation {
                if let Some(cmd) = commands.get_mut(&command) {
                    if let Some(slot) = cmd.slots.get_mut(&slot_id) {
                        slot.lines.push(captured);
                    }
                }
            }
        }

        if let Some((id, command, flag)) = flag_for_line {
            commands.entry(command).or_default().flags.insert(id, flag);
        }

        i += 1;
    }

    commands
}

/// Join a marker line with following continuation lines while the (comment-
/// stripped) text ends in a backslash (SCHEMA_V2 §1.1). Returns
/// (logical_line, lines_consumed). The first line is used verbatim; each
/// continuation line has its leading `//` stripped before folding.
fn join_continuation(lines: &[&str], start: usize) -> (String, usize) {
    let mut acc = String::new();
    let mut idx = start;
    while idx < lines.len() {
        // The first line keeps its `//` (find_marker locates the tag in it);
        // continuation lines have the comment leader stripped.
        let piece = if idx == start {
            lines[idx].trim_end().to_string()
        } else {
            strip_comment_leader(lines[idx].trim_end())
        };
        idx += 1;

        if let Some(stripped) = piece.strip_suffix('\\') {
            acc.push_str(stripped.trim_end());
            acc.push(' ');
            // Continue folding the next line.
        } else {
            acc.push_str(&piece);
            break;
        }
    }
    (acc, idx - start)
}

/// Strip a leading `//` (and surrounding whitespace) from a comment line.
fn strip_comment_leader(line: &str) -> String {
    let t = line.trim_start();
    let t = t.strip_prefix("//").unwrap_or(t);
    t.trim_start().to_string()
}

fn apply_command_header(commands: &mut BTreeMap<String, Command>, tail: &str) {
    let attrs = parse_attrs_quoted(tail);
    let name = match attrs.get("name") {
        Some(n) => n.clone(),
        None => return,
    };
    let entry = commands.entry(name).or_default();
    entry.has_header = true;
    if let Some(about) = attrs.get("about") {
        entry.about = Some(about.clone());
    }
    if let Some(so) = attrs.get("slot-order") {
        entry.slot_order = split_csv(so);
    }
    if let Some(ib) = attrs.get("imports-base") {
        entry.imports_base = split_csv(ib);
    }
}

fn resolve_command(attrs: &BTreeMap<String, String>, stack: &[(String, String)]) -> String {
    if let Some(c) = attrs.get("command") {
        return c.clone();
    }
    if let Some((c, _)) = stack.last() {
        return c.clone();
    }
    DEFAULT_COMMAND.to_string()
}

fn find_marker(line: &str, tag: &str) -> Option<String> {
    let idx = line.find(tag)?;
    Some(line[idx + tag.len()..].to_string())
}

fn strip_doc_annotations(line: &str) -> String {
    let mut cut: Option<usize> = None;
    for tag in ["@doc-flag:", "@doc-test:", "@doc-snippet:", "@doc-command:"] {
        if let Some(idx) = line.find(tag) {
            let prefix = &line[..idx];
            let trimmed = prefix.trim_end();
            if let Some(slash_idx) = trimmed.rfind("//") {
                let before = line[..slash_idx].trim_end();
                let new_cut = before.len();
                cut = Some(match cut {
                    Some(prev) => prev.min(new_cut),
                    None => new_cut,
                });
            }
        }
    }
    match cut {
        Some(c) => line[..c].to_string(),
        None => line.to_string(),
    }
}

/// Parse whitespace-separated `key=value` attributes (no quoted values).
fn parse_attrs(tail: String) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for tok in tail.split_whitespace() {
        if let Some(eq) = tok.find('=') {
            out.insert(tok[..eq].to_string(), tok[eq + 1..].to_string());
        }
    }
    out
}

/// Like [`parse_attrs`] but supports a single quoted value (`about="..."`),
/// parsed to the closing quote so it may contain whitespace (SCHEMA_V2 §1.1).
fn parse_attrs_quoted(tail: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let bytes = tail.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        // Skip whitespace.
        while i < n && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        // Read key up to '=' or whitespace.
        let key_start = i;
        while i < n && bytes[i] != b'=' && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = tail[key_start..i].to_string();
        if i < n && bytes[i] == b'=' {
            i += 1; // consume '='
            if i < n && bytes[i] == b'"' {
                i += 1; // consume opening quote
                let val_start = i;
                while i < n && bytes[i] != b'"' {
                    i += 1;
                }
                let val = tail[val_start..i].to_string();
                if i < n {
                    i += 1; // consume closing quote
                }
                if !key.is_empty() {
                    out.insert(key, val);
                }
            } else {
                let val_start = i;
                while i < n && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                let val = tail[val_start..i].to_string();
                if !key.is_empty() {
                    out.insert(key, val);
                }
            }
        }
        // Bare token without '=': ignored.
    }
    out
}

fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Parse the tail after `@doc-flag:` into (flag_id, attrs).
fn parse_flag_attrs(tail: String) -> (String, BTreeMap<String, String>) {
    let mut tokens = tail.split_whitespace();
    let flag_id = tokens.next().unwrap_or("").to_string();
    let mut attrs = BTreeMap::new();
    for tok in tokens {
        if let Some(eq) = tok.find('=') {
            attrs.insert(tok[..eq].to_string(), tok[eq + 1..].to_string());
        }
    }
    (flag_id, attrs)
}

/// Build (flag_id, command, Flag) from parsed flag attributes.
fn parse_flag(
    parsed: &(String, BTreeMap<String, String>),
    fragment: String,
    stack: &[(String, String)],
) -> Option<(String, String, Flag)> {
    let (flag_id, attrs) = parsed;
    if flag_id.is_empty() {
        return None;
    }

    let command = resolve_command(attrs, stack);

    // Slot: explicit attr, else active snippet slot for that command, else "".
    let slot = attrs
        .get("slot")
        .cloned()
        .or_else(|| {
            stack
                .iter()
                .rev()
                .find(|(c, _)| c == &command)
                .map(|(_, s)| s.clone())
        })
        .unwrap_or_default();

    let kind = attrs
        .get("kind")
        .cloned()
        .unwrap_or_else(|| "param".to_string());
    let param_name = attrs.get("param_name").cloned();
    let special = attrs.get("special").cloned();
    let imports = attrs
        .get("imports")
        .map(|v| split_csv(v))
        .unwrap_or_default();

    Some((
        flag_id.clone(),
        command,
        Flag {
            slot,
            kind,
            param_name,
            fragment,
            imports_when_active: imports,
            special,
            test: None,
        },
    ))
}

/// Parse a `@doc-test:` tail `<file>::<fn>:<line> [repo=...]` into a [`TestRef`].
/// `repo` is tri-state (SCHEMA_V2 §2.4): explicit `repo=` wins, else path
/// heuristic across `libviprs` / `libviprs-cli` / `libviprs-tests`.
fn parse_test_ref(tail: String) -> Option<TestRef> {
    let mut tokens = tail.split_whitespace();
    let token = tokens.next()?;

    // Optional repo= override anywhere in the remaining tokens.
    let mut repo_override: Option<String> = None;
    for tok in tokens {
        if let Some(rest) = tok.strip_prefix("repo=") {
            repo_override = Some(rest.to_string());
        }
    }

    let (rest, line_str) = token.rsplit_once(':')?;
    let line: u64 = line_str.parse().ok()?;
    let (file, fn_name) = rest.rsplit_once("::")?;

    let repo = repo_override.unwrap_or_else(|| resolve_repo(file));

    Some(TestRef {
        file: file.to_string(),
        fn_name: fn_name.to_string(),
        line,
        repo,
    })
}

/// Path heuristic for the tri-state `repo` (SCHEMA_V2 §2.4).
fn resolve_repo(file: &str) -> String {
    if file.starts_with("src/") || file.starts_with("./src/") {
        "libviprs".to_string()
    } else if file.starts_with("cli:")
        || file.starts_with("tests/cli_e2e")
        || file.contains("cli_e2e")
    {
        "libviprs-cli".to_string()
    } else {
        "libviprs-tests".to_string()
    }
}

// -------- tests --------

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd<'a>(map: &'a BTreeMap<String, Command>, name: &str) -> &'a Command {
        map.get(name)
            .unwrap_or_else(|| panic!("command {name} present"))
    }

    #[test]
    fn parses_empty_input() {
        let commands = parse("");
        assert!(commands.is_empty());
    }

    #[test]
    fn basic_snippet_defaults_to_pyramid_command() {
        let src = r#"
fn main() {
    // @doc-snippet:begin slot=planner imports=PyramidPlanner
    let planner = PyramidPlanner::new(); // @doc-test: tests/cli_smoke.rs::planner_default:42
    planner.set_levels(5);                // @doc-flag: levels kind=param param_name=levels
    // @doc-snippet:end slot=planner
}
"#;
        let commands = parse(src);
        // Everything resolves to the built-in default command `pyramid` (§1.2).
        let pyramid = cmd(&commands, "pyramid");
        assert!(pyramid.slots.contains_key("planner"));
        let slot = &pyramid.slots["planner"];
        assert_eq!(slot.imports_when_active, vec!["PyramidPlanner".to_string()]);
        assert_eq!(slot.lines.len(), 2);
        assert!(slot.lines[0].contains("PyramidPlanner::new()"));
        assert!(!slot.lines[0].contains("@doc-test"));

        let flag = pyramid.flags.get("levels").expect("flag present");
        assert_eq!(flag.slot, "planner");
        assert_eq!(flag.kind, "param");
        assert_eq!(flag.param_name.as_deref(), Some("levels"));
        assert!(!flag.fragment.contains("@doc-flag"));
    }

    #[test]
    fn doc_test_attaches_to_next_flag() {
        let src = r#"
    // @doc-snippet:begin slot=geo
    // @doc-test: tests/geo.rs::set_extent:10
    cfg.set_extent(extent); // @doc-flag: extent kind=param param_name=extent
    // @doc-snippet:end slot=geo
"#;
        let commands = parse(src);
        let flag = cmd(&commands, "pyramid").flags.get("extent").expect("flag");
        let test = flag.test.as_ref().expect("test present");
        assert_eq!(test.file, "tests/geo.rs");
        assert_eq!(test.fn_name, "set_extent");
        assert_eq!(test.line, 10);
        assert_eq!(test.repo, "libviprs-tests");
    }

    #[test]
    fn command_scoping_routes_snippets_and_flags() {
        // Two ops in one file, both defining slot=apply and a --mask flag.
        let src = r#"
// @doc-command:begin name=erode slot-order=apply imports-base=decode_file
// @doc-command:begin name=dilate slot-order=apply imports-base=decode_file

    // @doc-snippet:begin command=erode slot=apply
    let out = raster.try_erode(&mask)?;  // @doc-flag: mask command=erode kind=param param_name=mask
    // @doc-snippet:end command=erode slot=apply

    // @doc-snippet:begin command=dilate slot=apply
    let out = raster.try_dilate(&mask)?; // @doc-flag: mask command=dilate kind=param param_name=mask
    // @doc-snippet:end command=dilate slot=apply
"#;
        let commands = parse(src);
        let erode = cmd(&commands, "erode");
        let dilate = cmd(&commands, "dilate");
        assert!(erode.slots["apply"].lines[0].contains("try_erode"));
        assert!(dilate.slots["apply"].lines[0].contains("try_dilate"));
        // The --mask flag exists independently under each command.
        assert!(erode.flags.contains_key("mask"));
        assert!(dilate.flags.contains_key("mask"));
        assert_eq!(erode.flags["mask"].slot, "apply");
        assert_eq!(dilate.flags["mask"].slot, "apply");
    }

    #[test]
    fn width_flag_does_not_collide_across_commands() {
        // test-image --width and black --width live in separate command scopes.
        let src = r#"
// @doc-command:begin name=test-image slot-order=make imports-base=generate_test_raster
// @doc-command:begin name=black slot-order=make imports-base=Raster

    // @doc-snippet:begin command=test-image slot=make
    let r = generate_test_raster(w, h)?; // @doc-flag: width command=test-image kind=param param_name=width
    // @doc-snippet:end command=test-image slot=make

    // @doc-snippet:begin command=black slot=make
    let r = Raster::black(w, h)?;         // @doc-flag: width command=black kind=param param_name=width
    // @doc-snippet:end command=black slot=make
"#;
        let commands = parse(src);
        // Same flag id under two commands, no clobbering.
        assert!(cmd(&commands, "test-image").flags.contains_key("width"));
        assert!(cmd(&commands, "black").flags.contains_key("width"));
        assert!(
            cmd(&commands, "test-image").slots["make"].lines[0].contains("generate_test_raster")
        );
        assert!(cmd(&commands, "black").slots["make"].lines[0].contains("Raster::black"));
    }

    #[test]
    fn doc_command_sources_metadata() {
        let src = r#"
// @doc-command:begin name=erode about="Erode with a morphological mask" slot-order=load,apply,save imports-base=decode_file,save_file,Morphology
    // @doc-snippet:begin command=erode slot=load
    let raster = decode_file(&input)?;
    // @doc-snippet:end command=erode slot=load
    // @doc-snippet:begin command=erode slot=apply
    let out = raster.try_erode(&mask)?;
    // @doc-snippet:end command=erode slot=apply
    // @doc-snippet:begin command=erode slot=save
    save_file(&out, &output)?;
    // @doc-snippet:end command=erode slot=save
"#;
        let commands = parse(src);
        let erode = cmd(&commands, "erode");
        assert!(erode.has_header);
        assert_eq!(
            erode.about.as_deref(),
            Some("Erode with a morphological mask")
        );
        assert_eq!(erode.slot_order, vec!["load", "apply", "save"]);
        assert_eq!(
            erode.imports_base,
            vec!["decode_file", "save_file", "Morphology"]
        );
        // command_out_value should succeed (header present, slot_order matches).
        let v = command_out_value("erode", erode).expect("valid command");
        assert_eq!(v["interactive"], serde_json::json!(false));
        assert_eq!(
            v["about"],
            serde_json::json!("Erode with a morphological mask")
        );
    }

    #[test]
    fn non_pyramid_command_without_header_errors() {
        // A command with content but no @doc-command block is a hard error.
        let src = r#"
    // @doc-snippet:begin command=erode slot=apply
    let out = raster.try_erode(&mask)?;
    // @doc-snippet:end command=erode slot=apply
"#;
        let commands = parse(src);
        let erode = cmd(&commands, "erode");
        assert!(!erode.has_header);
        let err = command_out_value("erode", erode).unwrap_err();
        assert!(err.contains("no @doc-command block"), "got: {err}");
    }

    #[test]
    fn tri_state_repo_resolution() {
        // src/ → core crate.
        assert_eq!(
            parse_test_ref("src/engine.rs::run:7".to_string())
                .unwrap()
                .repo,
            "libviprs"
        );
        // cli_e2e → the CLI crate.
        assert_eq!(
            parse_test_ref("tests/cli_e2e/smoke.rs::help_prints:3".to_string())
                .unwrap()
                .repo,
            "libviprs-cli"
        );
        // Explicit repo= override wins over the heuristic.
        assert_eq!(
            parse_test_ref("tests/foo.rs::bar:1 repo=libviprs-cli".to_string())
                .unwrap()
                .repo,
            "libviprs-cli"
        );
        // Default bucket.
        assert_eq!(
            parse_test_ref("blank_tile_strategy.rs::emit:138".to_string())
                .unwrap()
                .repo,
            "libviprs-tests"
        );
    }

    #[test]
    fn baseline_assert_passes_on_embedded_pyramid() {
        // The committed embedded pyramid must satisfy the frozen baseline.
        let pyramid: Value = serde_json::from_str(PYRAMID_COMMAND_JSON).unwrap();
        assert!(assert_pyramid_baseline(&pyramid).is_ok());
    }

    #[test]
    fn baseline_assert_fires_on_truncated_input() {
        // Drop a slot from the embedded pyramid → the guard must fail loud.
        let mut pyramid: Value = serde_json::from_str(PYRAMID_COMMAND_JSON).unwrap();
        pyramid
            .get_mut("slots")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("planner");
        let order = pyramid
            .get_mut("slot_order")
            .and_then(Value::as_array_mut)
            .unwrap();
        order.retain(|v| v.as_str() != Some("planner"));
        let err = assert_pyramid_baseline(&pyramid).unwrap_err();
        assert!(err.contains("slot_order"), "got: {err}");

        // Also: a completely empty object trips the missing-field path.
        let empty = serde_json::json!({});
        assert!(assert_pyramid_baseline(&empty).is_err());
    }

    #[test]
    fn build_manifest_emits_v2_shape() {
        let commands = parse(""); // empty parse; pyramid injected from embed.
        let manifest = build_manifest(commands).expect("manifest");
        assert_eq!(manifest["version"], serde_json::json!(2));
        assert!(manifest["commands"]["pyramid"]["interactive"]
            .as_bool()
            .unwrap());
        assert_eq!(
            manifest["commands"]["pyramid"]["flags"]
                .as_object()
                .unwrap()
                .len(),
            31
        );
    }

    #[test]
    fn quoted_about_parses_with_spaces() {
        let attrs =
            parse_attrs_quoted(r#"name=erode about="Erode with a mask" slot-order=load,apply"#);
        assert_eq!(attrs.get("name").map(String::as_str), Some("erode"));
        assert_eq!(
            attrs.get("about").map(String::as_str),
            Some("Erode with a mask")
        );
        assert_eq!(
            attrs.get("slot-order").map(String::as_str),
            Some("load,apply")
        );
    }

    #[test]
    fn strip_keeps_indentation() {
        let s = strip_doc_annotations("    let x = 1; // @doc-flag: x kind=param");
        assert_eq!(s, "    let x = 1;");
    }

    #[test]
    fn imports_csv_split() {
        assert_eq!(
            split_csv("Foo, Bar ,Baz"),
            vec!["Foo".to_string(), "Bar".to_string(), "Baz".to_string()]
        );
    }
}
