//! extract-cli-snippets
//!
//! Reads an annotated Rust CLI source file and emits a JSON snippet manifest
//! used by an interactive doc page. See the crate's task description for the
//! full marker syntax and JSON shape (version 1).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::{json, Value};

// -------- canonical constants (version 1) --------

const VERSION: u32 = 1;
const COMMAND: &str = "pyramid";

const IMPORTS_BASE: &[&str] = &[
    "EngineBuilder",
    "EngineConfig",
    "FsSink",
    "Layout",
    "PyramidPlanner",
    "TileFormat",
    "decode_file",
];

const SLOT_ORDER: &[&str] = &[
    "tracing-init",
    "load-source",
    "planner",
    "memory-limit",
    "geo",
    "sink",
    "engine-config",
    "engine-builder",
    "finish",
];

// -------- data structures --------

#[derive(Debug, Default, Serialize)]
struct Slot {
    imports_when_active: Vec<String>,
    lines: Vec<String>,
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

// -------- main --------

fn main() -> ExitCode {
    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => {
            // Fallback to current directory when invoked outside cargo.
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    };

    let input_path = manifest_dir.join("../../rust/main.rs");
    let output_path = manifest_dir.join("../../js/snippets.generated.json");

    let source = match fs::read_to_string(&input_path) {
        Ok(s) => s,
        Err(e) => {
            // Tolerate a missing input: emit an empty skeleton just like the
            // zero-marker case described in the spec.
            eprintln!(
                "extract-cli-snippets: input not readable ({}): {} — emitting empty skeleton",
                input_path.display(),
                e
            );
            String::new()
        }
    };

    let (slots, flags) = parse(&source);

    let manifest = build_manifest(slots, flags);
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

    if let Err(e) = fs::write(&output_path, &pretty) {
        eprintln!(
            "extract-cli-snippets: failed to write {}: {}",
            output_path.display(),
            e
        );
        return ExitCode::from(1);
    }

    let n_flags = manifest
        .get("flags")
        .and_then(Value::as_object)
        .map(|o| o.len())
        .unwrap_or(0);
    let m_slots = manifest
        .get("slots")
        .and_then(Value::as_object)
        .map(|o| o.len())
        .unwrap_or(0);
    println!("wrote {n_flags} flags across {m_slots} slots");
    ExitCode::from(0)
}

// -------- manifest assembly --------

fn build_manifest(slots: BTreeMap<String, Slot>, flags: BTreeMap<String, Flag>) -> Value {
    let mut slots_json = serde_json::Map::new();
    for (id, slot) in &slots {
        slots_json.insert(id.clone(), serde_json::to_value(slot).unwrap());
    }
    let mut flags_json = serde_json::Map::new();
    for (id, flag) in &flags {
        flags_json.insert(id.clone(), serde_json::to_value(flag).unwrap());
    }

    json!({
        "version": VERSION,
        "command": COMMAND,
        "imports_base": IMPORTS_BASE,
        "slot_order": SLOT_ORDER,
        "slots": slots_json,
        "flags": flags_json,
    })
}

// -------- parser --------

/// Parse the annotated source into (slots, flags).
fn parse(source: &str) -> (BTreeMap<String, Slot>, BTreeMap<String, Flag>) {
    let mut slots: BTreeMap<String, Slot> = BTreeMap::new();
    let mut flags: BTreeMap<String, Flag> = BTreeMap::new();

    // Active snippet stack: (slot_id, lines accumulator).
    // Snippets shouldn't nest in practice, but we tolerate it: we always write
    // into the top of the stack.
    let mut stack: Vec<String> = Vec::new();

    // A pending @doc-test annotation from the previous line that should
    // attach to the next @doc-flag.
    let mut pending_test: Option<TestRef> = None;

    for raw_line in source.lines() {
        // First, detect markers. We look for marker substrings rather than
        // try to parse Rust.
        if let Some(begin) = find_marker(raw_line, "@doc-snippet:begin") {
            // Parse the tail after "@doc-snippet:begin".
            let attrs = parse_attrs(begin);
            if let Some(slot_id) = attrs.get("slot").cloned() {
                let imports = attrs
                    .get("imports")
                    .map(|v| split_csv(v))
                    .unwrap_or_default();
                let entry = slots.entry(slot_id.clone()).or_default();
                // If the slot already had imports, prefer the last seen set;
                // re-opening a slot is unusual but we won't error.
                if !imports.is_empty() {
                    entry.imports_when_active = imports;
                }
                stack.push(slot_id);
            }
            // The :begin line itself is never captured.
            continue;
        }

        if let Some(end) = find_marker(raw_line, "@doc-snippet:end") {
            let attrs = parse_attrs(end);
            if let Some(slot_id) = attrs.get("slot").cloned() {
                // Pop the most recent matching slot from the stack.
                if let Some(pos) = stack.iter().rposition(|s| s == &slot_id) {
                    stack.remove(pos);
                }
            } else if !stack.is_empty() {
                stack.pop();
            }
            continue;
        }

        // Non-marker line: handle @doc-test (sets pending) and/or @doc-flag.
        // A line may carry both annotations; we process @doc-test first so the
        // same-line @doc-flag picks it up.
        let mut line_test: Option<TestRef> = None;
        if let Some(test_tail) = find_marker(raw_line, "@doc-test:") {
            line_test = parse_test_ref(test_tail);
        }

        let mut flag_for_line: Option<(String, Flag)> = None;
        if let Some(flag_tail) = find_marker(raw_line, "@doc-flag:") {
            let fragment = strip_doc_annotations(raw_line);
            let parsed = parse_flag(flag_tail, fragment, stack.last().cloned());
            if let Some((id, mut flag)) = parsed {
                // Test attachment priority: same-line > pending-from-previous-line.
                let test = line_test.take().or_else(|| pending_test.take());
                flag.test = test;
                flag_for_line = Some((id, flag));
            }
        }

        // If the line carried a @doc-test but no @doc-flag, hold it for the
        // next @doc-flag we encounter.
        if let Some(t) = line_test {
            pending_test = Some(t);
        }

        // Capture line into the active slot (with annotation comments stripped).
        if let Some(active) = stack.last() {
            let captured = strip_doc_annotations(raw_line);
            // Skip lines that consist solely of an annotation comment (i.e.
            // were just a marker carrier). We still keep blank lines that
            // were originally blank.
            let is_pure_annotation =
                captured.trim().is_empty() && !raw_line.trim().is_empty();
            if !is_pure_annotation {
                if let Some(slot) = slots.get_mut(active) {
                    slot.lines.push(captured);
                }
            }
        }

        if let Some((id, flag)) = flag_for_line {
            flags.insert(id, flag);
        }
    }

    (slots, flags)
}

/// Locate the substring after a marker tag (e.g. "@doc-flag:") and return the
/// remainder of the line. Returns `None` if the marker isn't present.
fn find_marker<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    let idx = line.find(tag)?;
    let tail = &line[idx + tag.len()..];
    Some(tail)
}

/// Strip any trailing `// @doc-flag` / `// @doc-test` annotation comments
/// from a Rust line. Preserves the rest of the line verbatim including
/// indentation. If the only thing on the line is the annotation comment,
/// returns an empty string.
fn strip_doc_annotations(line: &str) -> String {
    let mut cut: Option<usize> = None;
    for tag in ["@doc-flag:", "@doc-test:", "@doc-snippet:"] {
        if let Some(idx) = line.find(tag) {
            // Walk backwards over whitespace and the leading `//`.
            let prefix = &line[..idx];
            let trimmed = prefix.trim_end();
            // The annotation must be inside a `// ...` comment; locate the
            // `//` that opens that comment.
            if let Some(slash_idx) = trimmed.rfind("//") {
                let candidate = slash_idx;
                // Trim trailing whitespace before `//`.
                let before = line[..candidate].trim_end();
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

/// Parse `key=value` attributes from a marker tail. Values may not contain
/// whitespace (we split on whitespace). Bare tokens without `=` are ignored.
fn parse_attrs(tail: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for tok in tail.split_whitespace() {
        if let Some(eq) = tok.find('=') {
            let k = tok[..eq].to_string();
            let v = tok[eq + 1..].to_string();
            out.insert(k, v);
        }
    }
    out
}

fn split_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Parse the tail after `@doc-flag:` into (flag_id, Flag) given the fragment
/// (the line with the annotation stripped) and the active slot.
fn parse_flag(tail: &str, fragment: String, active_slot: Option<String>) -> Option<(String, Flag)> {
    let mut tokens = tail.split_whitespace();
    let flag_id = tokens.next()?.to_string();

    // Remaining tokens are key=value attributes.
    let rest: Vec<&str> = tokens.collect();
    let mut attrs: BTreeMap<String, String> = BTreeMap::new();
    for tok in rest {
        if let Some(eq) = tok.find('=') {
            attrs.insert(tok[..eq].to_string(), tok[eq + 1..].to_string());
        }
    }

    let kind = attrs
        .get("kind")
        .cloned()
        .unwrap_or_else(|| "param".to_string());
    let param_name = attrs.get("param_name").cloned();
    let imports = attrs
        .get("imports")
        .map(|v| split_csv(v))
        .unwrap_or_default();

    let slot = active_slot.unwrap_or_default();

    Some((
        flag_id,
        Flag {
            slot,
            kind,
            param_name,
            fragment,
            imports_when_active: imports,
            test: None,
        },
    ))
}

/// Parse a `@doc-test:` tail of the form `<file>::<fn>:<line>` (whitespace
/// trimmed). Returns `None` if it doesn't match.
fn parse_test_ref(tail: &str) -> Option<TestRef> {
    // Take the first whitespace-separated token; everything else is ignored.
    let token = tail.split_whitespace().next()?;
    // Split on the *last* `:` first to grab the line, then on `::` for fn.
    let (rest, line_str) = token.rsplit_once(':')?;
    let line: u64 = line_str.parse().ok()?;
    let (file, fn_name) = rest.rsplit_once("::")?;
    let repo = if file.starts_with("src/") || file.starts_with("./src/") {
        "libviprs"
    } else {
        "libviprs-tests"
    }
    .to_string();
    Some(TestRef {
        file: file.to_string(),
        fn_name: fn_name.to_string(),
        line,
        repo,
    })
}

// -------- tests --------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_input() {
        let (slots, flags) = parse("");
        assert!(slots.is_empty());
        assert!(flags.is_empty());
    }

    #[test]
    fn parses_basic_snippet_with_flag_and_test() {
        let src = r#"
fn main() {
    // @doc-snippet:begin slot=planner imports=PyramidPlanner
    let planner = PyramidPlanner::new(); // @doc-test: tests/cli_smoke.rs::planner_default:42
    planner.set_levels(5);                // @doc-flag: levels kind=param param_name=levels
    // @doc-snippet:end slot=planner
}
"#;
        let (slots, flags) = parse(src);
        assert!(slots.contains_key("planner"));
        let slot = &slots["planner"];
        assert_eq!(slot.imports_when_active, vec!["PyramidPlanner".to_string()]);
        assert_eq!(slot.lines.len(), 2);
        assert!(slot.lines[0].contains("PyramidPlanner::new()"));
        assert!(!slot.lines[0].contains("@doc-test"));

        let flag = flags.get("levels").expect("flag present");
        assert_eq!(flag.slot, "planner");
        assert_eq!(flag.kind, "param");
        assert_eq!(flag.param_name.as_deref(), Some("levels"));
        // The flag fragment should not contain its own annotation tail.
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
        let (_slots, flags) = parse(src);
        let flag = flags.get("extent").expect("flag present");
        let test = flag.test.as_ref().expect("test present");
        assert_eq!(test.file, "tests/geo.rs");
        assert_eq!(test.fn_name, "set_extent");
        assert_eq!(test.line, 10);
        assert_eq!(test.repo, "libviprs-tests");
    }

    #[test]
    fn src_path_routes_to_libviprs_repo() {
        let t = parse_test_ref("src/engine.rs::run:7").unwrap();
        assert_eq!(t.repo, "libviprs");
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
