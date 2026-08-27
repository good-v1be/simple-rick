#!/usr/bin/env python3
"""
Run Simple Rick E2E tests and generate an HTML report.

Usage:
    python3 e2e/run_tests_report.py           # run all, open report
    python3 e2e/run_tests_report.py -k init   # filter tests
"""

import io
import json
import os
import sys
import time
import unittest
import webbrowser
from pathlib import Path

# Add e2e to path
sys.path.insert(0, str(Path(__file__).parent))
import test_mcp_e2e  # noqa: E402

REPORT_PATH = Path(__file__).parent / "report.html"


class ReportResult(unittest.TestResult):
    """Collects structured test results."""

    def __init__(self):
        super().__init__()
        self.records: list[dict] = []
        self._times: dict[str, float] = {}
        self._bufs: dict[str, io.StringIO] = {}
        self._real_stdout = sys.stdout

    def startTest(self, test):
        super().startTest(test)
        self._times[test.id()] = time.time()
        self._bufs[test.id()] = io.StringIO()
        sys.stdout = self._bufs[test.id()]

    def stopTest(self, test):
        sys.stdout = self._real_stdout
        super().stopTest(test)

    def _add(self, test, status, msg=""):
        elapsed = time.time() - self._times.get(test.id(), time.time())
        output = self._bufs.get(test.id(), io.StringIO()).getvalue().strip()
        self.records.append({
            "id": test.id(),
            "cls": test.__class__.__name__,
            "name": test._testMethodName,
            "doc": (test._testMethodDoc or "").strip(),
            "status": status,
            "message": str(msg)[:2000],
            "output": output[:5000],
            "duration_s": round(elapsed, 2),
        })
        # Live progress to stderr
        icon = {"pass": "+", "fail": "X", "error": "!", "skip": "-"}[status]
        print(f"  [{icon}] {test._testMethodName} ({elapsed:.1f}s)", file=sys.stderr)

    def addSuccess(self, test):
        super().addSuccess(test)
        self._add(test, "pass")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._add(test, "fail", err[1])

    def addError(self, test, err):
        super().addError(test, err)
        self._add(test, "error", err[1])

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._add(test, "skip", reason)


def generate_html(records: list[dict], total_time: float) -> str:
    """Generate a self-contained HTML report."""
    data_json = json.dumps(records)
    n_pass = sum(1 for r in records if r["status"] == "pass")
    n_fail = sum(1 for r in records if r["status"] == "fail")
    n_error = sum(1 for r in records if r["status"] == "error")
    n_skip = sum(1 for r in records if r["status"] == "skip")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simple Rick MCP — E2E Test Report</title>
<style>
  :root {{
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --blue: #58a6ff;
    --purple: #bc8cff;
  }}
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 2rem; line-height: 1.5;
  }}
  .header {{
    display: flex; align-items: center; gap: 1.5rem;
    margin-bottom: 2rem; flex-wrap: wrap;
  }}
  .header h1 {{ font-size: 1.6rem; font-weight: 600; }}
  .header .subtitle {{ color: var(--muted); font-size: 0.9rem; }}
  .stats {{
    display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap;
  }}
  .stat {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem 1.5rem; min-width: 120px;
    text-align: center;
  }}
  .stat .num {{ font-size: 2rem; font-weight: 700; }}
  .stat .label {{ font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }}
  .stat.pass .num {{ color: var(--green); }}
  .stat.fail .num {{ color: var(--red); }}
  .stat.skip .num {{ color: var(--yellow); }}
  .stat.time .num {{ color: var(--blue); font-size: 1.4rem; }}

  .progress-bar {{
    height: 8px; border-radius: 4px; background: var(--border);
    margin-bottom: 2rem; overflow: hidden; display: flex;
  }}
  .progress-bar .seg {{ height: 100%; }}
  .progress-bar .seg.pass {{ background: var(--green); }}
  .progress-bar .seg.fail {{ background: var(--red); }}
  .progress-bar .seg.skip {{ background: var(--yellow); }}

  .group {{ margin-bottom: 2rem; }}
  .group-header {{
    font-size: 1.1rem; font-weight: 600; color: var(--purple);
    margin-bottom: 0.5rem; padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border);
  }}
  .test {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; margin-bottom: 0.5rem; overflow: hidden;
    transition: border-color 0.15s;
  }}
  .test:hover {{ border-color: var(--muted); }}
  .test-header {{
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 1rem; cursor: pointer; user-select: none;
  }}
  .test-header:hover {{ background: rgba(255,255,255,0.02); }}
  .badge {{
    display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px;
    font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    flex-shrink: 0;
  }}
  .badge.pass {{ background: rgba(63,185,80,0.15); color: var(--green); }}
  .badge.fail {{ background: rgba(248,81,73,0.15); color: var(--red); }}
  .badge.error {{ background: rgba(248,81,73,0.2); color: var(--red); }}
  .badge.skip {{ background: rgba(210,153,34,0.15); color: var(--yellow); }}
  .test-name {{ font-weight: 500; flex: 1; }}
  .test-doc {{ color: var(--muted); font-size: 0.85rem; }}
  .test-duration {{ color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }}
  .test-body {{
    display: none; padding: 0.75rem 1rem; border-top: 1px solid var(--border);
    background: rgba(0,0,0,0.15);
  }}
  .test.open .test-body {{ display: block; }}
  .test-body pre {{
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem;
    white-space: pre-wrap; word-break: break-word; line-height: 1.6;
    color: var(--muted);
  }}
  .test-body .error-msg {{
    color: var(--red); background: rgba(248,81,73,0.08);
    padding: 0.5rem 0.75rem; border-radius: 4px; margin-bottom: 0.5rem;
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem;
    white-space: pre-wrap;
  }}
  .test-body h4 {{
    font-size: 0.75rem; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.06em; margin: 0.75rem 0 0.25rem;
  }}
  .filter-bar {{
    display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap;
  }}
  .filter-btn {{
    background: var(--surface); border: 1px solid var(--border);
    color: var(--text); padding: 0.4rem 0.8rem; border-radius: 6px;
    cursor: pointer; font-size: 0.85rem; transition: all 0.15s;
  }}
  .filter-btn:hover {{ border-color: var(--muted); }}
  .filter-btn.active {{ border-color: var(--blue); background: rgba(88,166,255,0.1); }}

  .output-section {{ margin-top: 0.5rem; }}
  .output-line {{ padding: 0.1rem 0; }}
  .output-line .tag {{
    display: inline-block; min-width: 90px; font-weight: 600;
    color: var(--blue); font-size: 0.8rem;
  }}
  .output-line .val {{ color: var(--text); }}
  .output-line .val.num {{ color: var(--green); font-weight: 600; }}

  @media (max-width: 600px) {{
    body {{ padding: 1rem; }}
    .stats {{ gap: 0.5rem; }}
    .stat {{ padding: 0.75rem 1rem; min-width: 90px; }}
    .stat .num {{ font-size: 1.5rem; }}
  }}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Simple Rick MCP — E2E Test Report</h1>
    <div class="subtitle">Generated {time.strftime("%Y-%m-%d %H:%M:%S")} &middot; Model: {test_mcp_e2e.MODEL}</div>
  </div>
</div>

<div class="stats">
  <div class="stat pass"><div class="num">{n_pass}</div><div class="label">Passed</div></div>
  <div class="stat fail"><div class="num">{n_fail + n_error}</div><div class="label">Failed</div></div>
  <div class="stat skip"><div class="num">{n_skip}</div><div class="label">Skipped</div></div>
  <div class="stat time"><div class="num">{total_time:.0f}s</div><div class="label">Total Time</div></div>
</div>

<div class="progress-bar">
  <div class="seg pass" style="width:{n_pass/max(len(records),1)*100:.1f}%"></div>
  <div class="seg fail" style="width:{(n_fail+n_error)/max(len(records),1)*100:.1f}%"></div>
  <div class="seg skip" style="width:{n_skip/max(len(records),1)*100:.1f}%"></div>
</div>

<div class="filter-bar">
  <button class="filter-btn active" onclick="filter('all')">All ({len(records)})</button>
  <button class="filter-btn" onclick="filter('pass')">Passed ({n_pass})</button>
  <button class="filter-btn" onclick="filter('fail')">Failed ({n_fail + n_error})</button>
  <button class="filter-btn" onclick="filter('skip')">Skipped ({n_skip})</button>
  <button class="filter-btn" onclick="toggleAll()">Expand All</button>
</div>

<div id="results"></div>

<script>
const DATA = {data_json};

function render(filterStatus) {{
  const container = document.getElementById('results');
  const groups = {{}};
  DATA.forEach(t => {{
    if (filterStatus && filterStatus !== 'all' && t.status !== filterStatus) return;
    (groups[t.cls] = groups[t.cls] || []).push(t);
  }});

  let html = '';
  for (const [cls, tests] of Object.entries(groups)) {{
    html += `<div class="group"><div class="group-header">${{cls}}</div>`;
    tests.forEach(t => {{
      const hasBody = t.output || t.message;
      html += `<div class="test ${{t.status}}" data-status="${{t.status}}">
        <div class="test-header" ${{hasBody ? 'onclick="this.parentElement.classList.toggle(\\'open\\')"' : ''}}>
          <span class="badge ${{t.status}}">${{t.status}}</span>
          <span class="test-name">${{t.name}}</span>
          <span class="test-doc">${{t.doc}}</span>
          <span class="test-duration">${{t.duration_s}}s</span>
        </div>`;
      if (hasBody) {{
        html += `<div class="test-body">`;
        if (t.message && t.status !== 'pass') {{
          html += `<div class="error-msg">${{escHtml(t.message)}}</div>`;
        }}
        if (t.output) {{
          html += `<h4>Output</h4><pre>${{formatOutput(t.output)}}</pre>`;
        }}
        html += `</div>`;
      }}
      html += `</div>`;
    }});
    html += `</div>`;
  }}
  container.innerHTML = html;
}}

function formatOutput(text) {{
  return escHtml(text)
    .replace(/\\[([^\\]]+)\\]/g, '<span style="color:var(--blue)">[$1]</span>')
    .replace(/(\\d+) (chunk|session|edge|turn|file|entit)/gi, '<span style="color:var(--green);font-weight:600">$1</span> $2')
    .replace(/(WARNING|FAIL|ERROR)/g, '<span style="color:var(--red);font-weight:600">$1</span>')
    .replace(/(OK|pass|success)/gi, '<span style="color:var(--green)">$1</span>');
}}

function escHtml(s) {{
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}}

function filter(status) {{
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  render(status);
}}

let expanded = false;
function toggleAll() {{
  expanded = !expanded;
  document.querySelectorAll('.test').forEach(t => {{
    t.classList.toggle('open', expanded);
  }});
}}

render('all');

// Auto-expand failures
document.querySelectorAll('.test.fail, .test.error').forEach(t => t.classList.add('open'));
</script>
</body>
</html>"""


def main():
    # Parse -k filter
    filter_pattern = None
    if "-k" in sys.argv:
        idx = sys.argv.index("-k")
        if idx + 1 < len(sys.argv):
            filter_pattern = sys.argv[idx + 1]

    print(f"\nSimple Rick MCP — E2E Test Runner", file=sys.stderr)
    print(f"Model: {test_mcp_e2e.MODEL}", file=sys.stderr)
    print(f"{'='*50}\n", file=sys.stderr)

    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(test_mcp_e2e)

    # Apply filter
    if filter_pattern:
        filtered = unittest.TestSuite()
        for group in suite:
            for test in group:
                if filter_pattern.lower() in test.id().lower():
                    filtered.addTest(test)
        suite = filtered

    result = ReportResult()
    t0 = time.time()
    suite.run(result)
    total = time.time() - t0

    # Generate HTML
    html = generate_html(result.records, total)
    REPORT_PATH.write_text(html)

    n_pass = sum(1 for r in result.records if r["status"] == "pass")
    n_fail = sum(1 for r in result.records if r["status"] in ("fail", "error"))
    n_skip = sum(1 for r in result.records if r["status"] == "skip")

    print(f"\n{'='*50}", file=sys.stderr)
    print(f"  {n_pass} passed, {n_fail} failed, {n_skip} skipped in {total:.0f}s", file=sys.stderr)
    print(f"  Report: {REPORT_PATH}", file=sys.stderr)

    # Open in browser
    webbrowser.open(f"file://{REPORT_PATH}")

    sys.exit(1 if n_fail > 0 else 0)


if __name__ == "__main__":
    main()
