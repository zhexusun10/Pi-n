//! Leads for project paths that a bash command may have written.
//!
//! Bash is opaque: `sed -i`, redirects, formatters and interpreter scripts
//! change files without a `write`/`edit` tool call. These helpers only *name*
//! paths the same command mentions. They never claim a change; `bash_verify`
//! keeps a lead only when the baseline comparison shows the path really
//! differs, so unrelated edits by another agent or the user stay unattributed.

/// Delimiter of a `<<EOF`, `<<-'EOF'` or `<<"EOF"` here-document opened on
/// `line`. Here-strings (`<<<`) are not here-documents.
pub(super) fn heredoc_delimiter(line: &str) -> Option<String> {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'<' && bytes[index + 1] == b'<' {
            if index > 0 && bytes[index - 1] == b'<' {
                index += 2;
                continue;
            }
            if bytes.get(index + 2) == Some(&b'<') {
                index += 3;
                continue;
            }
            let rest = line[index + 2..].trim_start_matches('-').trim_start();
            let word: String = rest
                .chars()
                .take_while(|character| {
                    !character.is_whitespace() && !matches!(character, ';' | '&' | '|' | ')')
                })
                .filter(|character| !matches!(character, '\'' | '"' | '\\'))
                .collect();
            if !word.is_empty() {
                return Some(word);
            }
        }
        index += 1;
    }
    None
}

const LAUNCHERS: &[&str] = &[
    "sudo", "env", "command", "time", "nice", "npx", "bunx", "pnpm", "yarn", "exec", "dlx",
];
const FORMATTERS: &[&str] = &[
    "prettier",
    "eslint",
    "stylelint",
    "biome",
    "gofmt",
    "rustfmt",
    "black",
    "ruff",
    "isort",
];

fn is_flag(token: &str) -> bool {
    token.starts_with('-') && token.len() > 1
}

fn non_flags(args: &[String]) -> Vec<&str> {
    args.iter()
        .map(String::as_str)
        .filter(|argument| !is_flag(argument))
        .collect()
}

fn in_place_flag(args: &[String]) -> bool {
    args.iter().any(|argument| {
        argument == "--in-place"
            || argument.starts_with("--in-place=")
            || (argument.starts_with('-')
                && !argument.starts_with("--")
                && argument[1..].contains('i'))
    })
}

/// Paths a redirect names (`> f`, `>> f`, `>f`, `1> f`, `&> f`). Standard error
/// and descriptor duplication (`2>`, `>&2`) are not project output.
fn redirect_targets(tokens: &[String]) -> Vec<&str> {
    let mut targets = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        let operator_only = matches!(token, ">" | ">>" | ">|" | "&>" | "&>>" | "1>" | "1>>");
        if operator_only {
            if let Some(next) = tokens.get(index + 1) {
                if !next.starts_with('&') {
                    targets.push(next.as_str());
                }
            }
            index += 2;
            continue;
        }
        let attached = token
            .strip_prefix(">>")
            .or_else(|| token.strip_prefix('>'))
            .filter(|rest| !rest.is_empty() && !rest.starts_with('&') && !rest.starts_with('|'));
        if let Some(path) = attached {
            targets.push(path);
        }
        index += 1;
    }
    targets
}

fn stage_targets(stage: &[String]) -> Vec<&str> {
    let mut start = 0;
    while start < stage.len() {
        let word = stage[start].trim_start_matches('(');
        let assignment = word.contains('=') && !word.starts_with('=') && !word.contains('/');
        if LAUNCHERS.contains(&word) || assignment || is_flag(word) && start > 0 {
            start += 1;
        } else {
            break;
        }
    }
    let Some(first) = stage.get(start) else {
        return Vec::new();
    };
    let cmd = first.trim_start_matches('(');
    let args = &stage[start + 1..];
    match cmd {
        "sed" | "gsed" | "perl" if in_place_flag(args) => non_flags(args),
        "tee" | "touch" => non_flags(args),
        "cp" | "install" | "rsync" => {
            let positional = non_flags(args);
            if positional.len() >= 2 {
                positional.last().copied().into_iter().collect()
            } else {
                Vec::new()
            }
        }
        "dd" => args
            .iter()
            .filter_map(|argument| argument.strip_prefix("of="))
            .collect(),
        _ => {
            let formatter = FORMATTERS.contains(&cmd)
                || args
                    .iter()
                    .any(|argument| FORMATTERS.contains(&argument.as_str()));
            let writes = args.iter().any(|argument| {
                matches!(argument.as_str(), "--write" | "--fix" | "-w" | "--in-place")
            });
            if formatter && writes {
                non_flags(args)
                    .into_iter()
                    .filter(|argument| !FORMATTERS.contains(argument))
                    .collect()
            } else {
                Vec::new()
            }
        }
    }
}

/// Every path-like word a command segment may write: redirect targets plus the
/// arguments of write-capable commands in each pipeline stage.
pub(super) fn segment_leads(tokens: &[String]) -> Vec<&str> {
    let mut leads = redirect_targets(tokens);
    for stage in tokens.split(|token| token == "|") {
        leads.extend(stage_targets(stage));
    }
    leads
}

const INTERPRETER_WRITE_MARKERS: &[&str] = &[
    "write_text(",
    "write_bytes(",
    "writeFileSync(",
    "writeFile(",
    "appendFileSync(",
    "appendFile(",
    "copyFileSync(",
    "renameSync(",
    "shutil.copy",
    "shutil.move",
    "os.replace(",
    "os.rename(",
    ".write(",
];

fn path_like_literal(text: &str) -> bool {
    if text.len() < 2
        || text.len() > 260
        || text.starts_with('-')
        || text.contains("://")
        || text.chars().any(|character| {
            character.is_whitespace()
                || character.is_control()
                || matches!(
                    character,
                    '$' | '{' | '}' | '*' | '?' | '<' | '>' | '|' | '(' | ')'
                )
        })
    {
        return false;
    }
    if text.contains('/') {
        return true;
    }
    match text.rsplit_once('.') {
        Some((stem, extension)) => {
            !stem.is_empty()
                && (1..=8).contains(&extension.len())
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Quoted path-like string literals of a command that also contains an
/// interpreter file-write call (`open(p, 'w').write(...)`, `writeFileSync`).
/// This is deliberately broad; the baseline comparison removes every literal
/// that was only read or never changed.
pub(super) fn interpreter_leads(command: &str) -> Vec<String> {
    if !INTERPRETER_WRITE_MARKERS
        .iter()
        .any(|marker| command.contains(marker))
    {
        return Vec::new();
    }
    let mut leads = Vec::new();
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\'' && character != '"' {
            continue;
        }
        let mut literal = String::new();
        let mut closed = false;
        for next in characters.by_ref() {
            if next == character {
                closed = true;
                break;
            }
            if next == '\n' || next == '\\' || literal.len() > 300 {
                break;
            }
            literal.push(next);
        }
        if closed && path_like_literal(&literal) && !leads.contains(&literal) {
            leads.push(literal);
        }
    }
    leads
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(command: &str) -> Vec<String> {
        super::super::split_shell_tokens(command)
    }

    #[test]
    fn here_document_delimiters_ignore_here_strings() {
        assert_eq!(
            heredoc_delimiter("cat > a.mjs <<'EOF'").as_deref(),
            Some("EOF")
        );
        assert_eq!(
            heredoc_delimiter("python3 - <<-\"PY\"").as_deref(),
            Some("PY")
        );
        assert_eq!(heredoc_delimiter("grep x <<< \"text\""), None);
        assert_eq!(heredoc_delimiter("echo done"), None);
    }

    #[test]
    fn names_the_files_a_write_capable_command_mentions() {
        let leads = |command: &str| {
            let tokens = words(command);
            segment_leads(&tokens)
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        assert_eq!(leads("sed -i 's/a/b/' README.md"), ["s/a/b/", "README.md"]);
        assert_eq!(leads("sed -n '1p' README.md"), Vec::<String>::new());
        assert_eq!(leads("cat > scripts/a.mjs <<'EOF'"), ["scripts/a.mjs"]);
        assert_eq!(leads("echo hi >> notes.txt"), ["notes.txt"]);
        assert_eq!(leads("make 2>&1 | tee build.log"), ["build.log"]);
        assert_eq!(leads("cp -r template out/app"), ["out/app"]);
        assert_eq!(leads("npx prettier --write src/a.ts"), ["src/a.ts"]);
        assert_eq!(leads("grep -rn foo src"), Vec::<String>::new());
        assert_eq!(leads("echo a > /dev/null"), ["/dev/null"]);
    }

    #[test]
    fn interpreter_scripts_name_quoted_paths_only_when_they_write() {
        let script =
            "python3 - <<'EOF'\np='src/styles.css'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF";
        assert_eq!(interpreter_leads(script), ["src/styles.css"]);
        assert!(interpreter_leads("python3 -c \"print(open('src/a.css').read())\"").is_empty());
    }
}
