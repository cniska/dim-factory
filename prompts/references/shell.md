# The shell

The harness refuses some commands without running them, and each refusal costs a call:

- a heredoc or `echo` whose text holds a brace beside a quote, as JSON does: write the file with the Write tool;
- `$(…)` read back through a bare variable, or `$?`;
- an unquoted glob, as in `find . -name *.ts`.

Logic that needs variables goes into a script under `$TMPDIR`, run with `sh "$TMPDIR/<name>.sh"`. Chains, pipes, quoted `"$TMPDIR"` paths and redirects to a fixed path run.
