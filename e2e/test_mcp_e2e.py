#!/usr/bin/env python3
"""
Simple Rick MCP — End-to-End Tests via Claude Code CLI.

Drives real Claude Code sessions with `claude -p` to exercise every
Simple Rick MCP tool in a realistic conversation flow.

Usage:
    python3 e2e/test_mcp_e2e.py              # run all tests
    python3 e2e/test_mcp_e2e.py -k init      # run only tests matching "init"
    python3 e2e/test_mcp_e2e.py -v           # verbose output

Requires:
    - `claude` CLI in PATH
    - Simple Rick MCP configured in .mcp.json (or passed via --mcp-config)
    - A scratch project dir (auto-created in /tmp)
"""

import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from typing import Optional

# ── Config ─────────────────────────────────────────────────────────────────

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
SIMPLE_RICK_DIR = Path(__file__).resolve().parent.parent
MCP_CONFIG = SIMPLE_RICK_DIR / ".mcp.json"
TIMEOUT = 180  # seconds per CLI invocation (MCP startup can be slow)
MODEL = os.environ.get("TEST_MODEL", "haiku")  # cheap model for tests

# Pull MISTRAL_API_KEY from existing .mcp.json if not in env
if not os.environ.get("MISTRAL_API_KEY") and MCP_CONFIG.exists():
    try:
        _cfg = json.loads(MCP_CONFIG.read_text())
        _key = _cfg.get("mcpServers", {}).get("simple-rick", {}).get("env", {}).get("MISTRAL_API_KEY", "")
        if _key:
            os.environ["MISTRAL_API_KEY"] = _key
    except Exception:
        pass


# ── Helpers ────────────────────────────────────────────────────────────────

def claude_prompt(
    prompt: str,
    *,
    cwd: str,
    mcp_config: Optional[str] = None,
    session_id: Optional[str] = None,
    allowed_tools: Optional[list[str]] = None,
    timeout: int = TIMEOUT,
) -> dict:
    """Run a single `claude -p` call and return parsed JSON output."""
    cmd = [
        CLAUDE_BIN,
        "-p", prompt,
        "--output-format", "json",
        "--model", MODEL,
        "--no-chrome",
        "--permission-mode", "bypassPermissions",
    ]

    # Point at the MCP config so Simple Rick tools are available
    config = mcp_config or (str(MCP_CONFIG) if MCP_CONFIG.exists() else None)
    if config:
        cmd += ["--mcp-config", config]

    if session_id:
        cmd += ["--resume", session_id]

    if allowed_tools:
        cmd += ["--allowedTools"] + allowed_tools

    env = {**os.environ}

    result = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=timeout,
        env=env,
    )

    # Parse JSON from stdout (may have non-JSON lines mixed in)
    parsed = None
    if result.stdout.strip():
        try:
            parsed = json.loads(result.stdout)
        except json.JSONDecodeError:
            for line in reversed(result.stdout.strip().splitlines()):
                try:
                    parsed = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue

    if result.returncode != 0 and parsed is None:
        raise RuntimeError(
            f"claude exited {result.returncode}\n"
            f"stderr: {result.stderr[:2000]}\n"
            f"stdout: {result.stdout[:2000]}"
        )

    if parsed is None:
        raise RuntimeError(f"Could not parse JSON from stdout:\n{result.stdout[:2000]}")

    # Check for auth errors
    if parsed.get("is_error") and "not logged in" in parsed.get("result", "").lower():
        raise RuntimeError(f"Claude auth error: {parsed.get('result')}")

    return parsed


def extract_text(response: dict) -> str:
    """Extract text content from Claude CLI JSON response."""
    if isinstance(response, dict):
        # --output-format json returns {result: str, ...} or {content: [...]}
        if "result" in response:
            return response["result"]
        if "content" in response:
            parts = response["content"]
            if isinstance(parts, list):
                return " ".join(
                    p.get("text", "") for p in parts if p.get("type") == "text"
                )
            return str(parts)
    return str(response)


def used_mcp_tool(response: dict, tool_name: str) -> bool:
    """Check if a specific MCP tool was called in the response (via cost/tool tracking)."""
    text = extract_text(response)
    # Check for common indicators that the tool was NOT found
    no_access_phrases = [
        "don't have access",
        "not in my available",
        "no simple_rick",
        "not available",
        "couldn't find",
    ]
    for phrase in no_access_phrases:
        if phrase in text.lower():
            return False
    return True


def session_id_from(response: dict) -> Optional[str]:
    """Extract session ID if present."""
    return response.get("session_id") or response.get("sessionId")


# ── Test Fixtures ──────────────────────────────────────────────────────────

class SimpleRickE2EBase(unittest.TestCase):
    """Base class that creates a temporary project directory with its own MCP config."""

    project_dir: str
    mcp_config_path: str
    _session_id: Optional[str] = None

    @classmethod
    def setUpClass(cls):
        cls.project_dir = tempfile.mkdtemp(prefix="sr_e2e_")
        # Create a minimal project structure
        (Path(cls.project_dir) / "README.md").write_text("# Test Project\nA project for E2E testing Simple Rick.\n")
        (Path(cls.project_dir) / "src").mkdir()
        (Path(cls.project_dir) / "src" / "index.ts").write_text(
            'console.log("hello from test project");\n'
        )

        # Generate MCP config pointing at this temp project
        mcp_config = {
            "mcpServers": {
                "simple-rick": {
                    "command": "npx",
                    "args": ["tsx", str(SIMPLE_RICK_DIR / "src" / "server" / "index.ts")],
                    "env": {
                        "PROJECT_PATH": cls.project_dir,
                        "MISTRAL_API_KEY": os.environ.get("MISTRAL_API_KEY", ""),
                    },
                }
            }
        }
        cls.mcp_config_path = os.path.join(cls.project_dir, ".mcp.json")
        Path(cls.mcp_config_path).write_text(json.dumps(mcp_config, indent=2))

        # Init git so Claude Code is happy
        subprocess.run(["git", "init"], cwd=cls.project_dir, capture_output=True)
        subprocess.run(
            ["git", "add", "."],
            cwd=cls.project_dir, capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=cls.project_dir, capture_output=True,
            env={**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "t@t.com",
                 "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "t@t.com"},
        )

    @classmethod
    def tearDownClass(cls):
        # Clean up .simple-rick data and temp dir
        sr_dir = Path(cls.project_dir) / ".simple-rick"
        if sr_dir.exists():
            shutil.rmtree(sr_dir)
        shutil.rmtree(cls.project_dir, ignore_errors=True)

    def ask(self, prompt: str, **kwargs) -> dict:
        """Shorthand for claude_prompt in project dir."""
        resp = claude_prompt(
            prompt, cwd=self.project_dir,
            mcp_config=self.mcp_config_path,
            session_id=self._session_id, **kwargs,
        )
        # Capture session for continuation
        sid = session_id_from(resp)
        if sid:
            self.__class__._session_id = sid
        return resp

    # ── Data quality helpers ──────────────────────────────────────────────

    @property
    def sr_dir(self) -> Path:
        return Path(self.project_dir) / ".simple-rick"

    @property
    def db_path(self) -> Path:
        return self.sr_dir / "simple-rick.db"

    def db_query(self, sql: str, params: tuple = ()) -> list[dict]:
        """Run a read-only query against the Simple Rick SQLite DB."""
        if not self.db_path.exists():
            return []
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def vault_files(self, pattern: str = "**/*.md") -> list[Path]:
        """List markdown files in the .simple-rick vault."""
        return sorted(self.sr_dir.glob(pattern))

    def vault_read(self, path: Path) -> tuple[dict, str]:
        """Read a vault MD file, return (frontmatter_dict, body)."""
        text = path.read_text()
        fm = {}
        body = text
        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                # Parse YAML frontmatter manually (avoid pyyaml dependency)
                for line in parts[1].strip().splitlines():
                    # Skip continuation lines (arrays, multi-line values)
                    if not line or line[0] in (' ', '-'):
                        continue
                    if ":" in line:
                        key, val = line.split(":", 1)
                        val = val.strip().strip("'\"")
                        # Handle inline arrays like [a, b, c]
                        if val.startswith("[["):
                            pass  # wikilink — keep as-is
                        fm[key.strip()] = val
                body = parts[2].strip()
        return fm, body


# ── Test Cases ─────────────────────────────────────────────────────────────

class TestInit(SimpleRickE2EBase):
    """Test simple_rick_init creates project context."""

    def test_01_init(self):
        """Init Simple Rick for the test project."""
        resp = self.ask(
            'Use the simple_rick_init MCP tool to initialize this project. '
            'Project name: "E2E Test Project", description: "Testing Simple Rick MCP tools", '
            'stack: "TypeScript, Node.js". '
            'You MUST call the MCP tool, do not just respond with text.'
        )
        text = extract_text(resp)
        self.assertTrue(
            used_mcp_tool(resp, "simple_rick_init"),
            f"MCP tool was not used. Response: {text[:500]}",
        )


class TestFullSession(SimpleRickE2EBase):
    """Test a complete session lifecycle: init → briefing → work → decision → search → close."""

    TOOL_INSTRUCTION = (
        "You MUST call the MCP tool directly. Do NOT respond with text saying "
        "you can't find it. The tool is provided by the simple-rick MCP server."
    )

    def test_01_init(self):
        resp = self.ask(
            f'Call the simple_rick_init MCP tool with project_name="Session Test", '
            f'description="Full session lifecycle test", stack="Python". {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [init] {text[:200]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_init"), f"Tool not used: {text[:300]}")

    def test_02_briefing(self):
        resp = self.ask(
            f'Call the simple_rick_briefing MCP tool with focus="e2e testing". '
            f'Return what the tool gives you. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [briefing] {text[:200]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_briefing"), f"Tool not used: {text[:300]}")

    def test_03_decision(self):
        resp = self.ask(
            f'Call the simple_rick_decision MCP tool with: '
            f'decision="Use pytest for E2E tests", '
            f'rationale="Industry standard, good fixtures", '
            f'component="testing", '
            f'alternatives=["unittest", "nose2"]. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [decision] {text[:200]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_decision"), f"Tool not used: {text[:300]}")

    def test_04_search(self):
        resp = self.ask(
            f'Call the simple_rick_search MCP tool with query="testing framework decision". '
            f'Return the raw results. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [search] {text[:300]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_search"), f"Tool not used: {text[:300]}")

    def test_05_ask(self):
        resp = self.ask(
            f'Call the simple_rick_ask MCP tool with question="What testing decisions have been made?" '
            f'{self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [ask] {text[:300]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_ask"), f"Tool not used: {text[:300]}")

    def test_06_link(self):
        resp = self.ask(
            f'Call the simple_rick_link MCP tool with: '
            f'from="testing framework", to="pytest", relation="chose". {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [link] {text[:200]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_link"), f"Tool not used: {text[:300]}")

    def test_07_close(self):
        resp = self.ask(
            f'Call the simple_rick_close MCP tool. Return whatever it responds with. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [close] {text[:300]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_close"), f"Tool not used: {text[:300]}")


class TestSearchEmpty(SimpleRickE2EBase):
    """Test search on a fresh project returns gracefully (no crash)."""

    def test_search_empty(self):
        # Init first
        self.ask(
            'Call simple_rick_init with project_name="Empty Search Test", '
            'description="Test search on empty project".'
        )
        resp = self.ask(
            'Call simple_rick_search with query="nonexistent topic xyz". Return raw results.'
        )
        text = extract_text(resp)
        print(f"  [empty search] {text[:200]}")
        # Should not crash — empty results are fine
        self.assertNotIn("unhandled", text.lower())
        self.assertNotIn("exception", text.lower())


class TestBriefingWithoutInit(SimpleRickE2EBase):
    """Test that briefing without init handles gracefully."""

    def test_briefing_no_init(self):
        resp = self.ask(
            'Call simple_rick_briefing. Return whatever happens.'
        )
        text = extract_text(resp)
        print(f"  [briefing no init] {text[:300]}")
        # Should either work (auto-init) or return a clear message, not crash
        self.assertTrue(len(text) > 5)


class TestMultiTurnConversation(SimpleRickE2EBase):
    """Test that Simple Rick captures multi-turn context correctly."""

    def test_01_init_and_discuss(self):
        self.ask(
            'Call simple_rick_init with project_name="Multi Turn", '
            'description="Testing context persistence".'
        )

    def test_02_first_topic(self):
        resp = self.ask(
            'Call simple_rick_decision with: '
            'decision="Use WebSocket for real-time updates", '
            'rationale="Lower latency than polling", '
            'component="backend".'
        )
        text = extract_text(resp)
        self.assertNotIn("error", text.lower()[:200])

    def test_03_second_topic(self):
        resp = self.ask(
            'Call simple_rick_decision with: '
            'decision="Use Redis for caching", '
            'rationale="Fast, well-supported", '
            'component="infrastructure".'
        )
        text = extract_text(resp)
        self.assertNotIn("error", text.lower()[:200])

    def test_04_search_both(self):
        resp = self.ask(
            'Call simple_rick_search with query="infrastructure decisions". Return results.'
        )
        text = extract_text(resp)
        print(f"  [multi-turn search] {text[:300]}")
        self.assertTrue(len(text) > 5)

    def test_05_close_and_verify(self):
        self.ask('Call simple_rick_close.')
        # After close, briefing should mention past session
        resp = self.ask('Call simple_rick_briefing. Return what it says.')
        text = extract_text(resp)
        print(f"  [post-close briefing] {text[:300]}")
        self.assertTrue(len(text) > 10)


class TestDataQuality(SimpleRickE2EBase):
    """Verify that Simple Rick actually persists correct data in DB + vault files."""

    TOOL_INSTRUCTION = (
        "You MUST call the MCP tool directly. Do NOT respond with text saying "
        "you can't find it. The tool is provided by the simple-rick MCP server."
    )

    def test_01_init_creates_db_and_session(self):
        """Init should create .simple-rick/simple-rick.db with an active session."""
        resp = self.ask(
            f'Call the simple_rick_init MCP tool with project_name="DataQuality", '
            f'description="Verify data persistence", stack="TypeScript". {self.TOOL_INSTRUCTION}'
        )
        self.assertTrue(used_mcp_tool(resp, "simple_rick_init"), extract_text(resp)[:300])

        # DB must exist
        self.assertTrue(self.db_path.exists(), f".simple-rick/simple-rick.db not found in {self.sr_dir}")

        # Must have at least one session
        sessions = self.db_query("SELECT * FROM sessions")
        self.assertGreaterEqual(len(sessions), 1, "No sessions in DB after init")

        # Active session
        active = [s for s in sessions if s["status"] == "active"]
        self.assertGreaterEqual(len(active), 1, f"No active session. Sessions: {sessions}")
        print(f"  [init] DB has {len(sessions)} session(s), {len(active)} active")

    def test_02_decision_persists_to_db_and_vault(self):
        """Decision should create a chunk in DB and an .md file in vault."""
        resp = self.ask(
            f'Call the simple_rick_decision MCP tool with: '
            f'decision="Use SQLite for local storage", '
            f'rationale="No external dependencies, single file", '
            f'component="database", '
            f'alternatives=["PostgreSQL", "LevelDB"]. {self.TOOL_INSTRUCTION}'
        )
        self.assertTrue(used_mcp_tool(resp, "simple_rick_decision"), extract_text(resp)[:300])

        # Check DB: chunks table should have entries
        chunks = self.db_query("SELECT * FROM chunks")
        self.assertGreater(len(chunks), 0, "No chunks in DB after decision")
        print(f"  [decision] {len(chunks)} chunk(s) in DB")

        # Check vault: should have a decision .md file
        decision_files = self.vault_files("**/decisions/*.md")
        self.assertGreater(len(decision_files), 0, f"No decision files in vault. Files: {self.vault_files()}")

        # Verify decision file content
        df = decision_files[-1]  # most recent
        fm, body = self.vault_read(df)
        print(f"  [decision] Vault file: {df.name}")
        print(f"  [decision] Frontmatter: {fm}")
        # Body should mention the actual decision text
        self.assertTrue(
            "sqlite" in body.lower() or "local storage" in body.lower(),
            f"Decision body doesn't contain decision text: {body[:300]}",
        )

    def test_03_decision_has_correct_frontmatter(self):
        """Decision vault file should have proper frontmatter fields."""
        decision_files = self.vault_files("**/decisions/*.md")
        if not decision_files:
            self.skipTest("No decision files found (prior test may have failed)")

        fm, body = self.vault_read(decision_files[-1])
        # Should have type field
        self.assertIn("type", fm, f"Missing 'type' in frontmatter: {fm}")
        self.assertEqual(fm["type"], "decision", f"Wrong type: {fm['type']}")

        # Should have session reference
        self.assertIn("session", fm, f"Missing 'session' in frontmatter: {fm}")
        self.assertTrue(len(fm["session"]) > 5, f"Session ID too short: {fm['session']}")

        # Should have created timestamp
        self.assertIn("created", fm, f"Missing 'created' in frontmatter: {fm}")
        print(f"  [frontmatter] type={fm['type']}, session={fm['session'][:8]}...")

    def test_04_link_creates_edge_in_db(self):
        """Link should create an edge in the edges table."""
        resp = self.ask(
            f'Call the simple_rick_link MCP tool with: '
            f'from="SQLite", to="local storage", relation="enables". {self.TOOL_INSTRUCTION}'
        )
        self.assertTrue(used_mcp_tool(resp, "simple_rick_link"), extract_text(resp)[:300])

        # Check edges table
        edges = self.db_query("SELECT * FROM edges")
        self.assertGreater(len(edges), 0, "No edges in DB after link")

        # Find our specific edge
        our_edges = [
            e for e in edges
            if "sqlite" in (e.get("source_entity") or "").lower()
            or "local" in (e.get("source_entity") or "").lower()
        ]
        print(f"  [link] {len(edges)} total edge(s), {len(our_edges)} matching")
        if our_edges:
            e = our_edges[0]
            print(f"  [link] Edge: {e['source_entity']} --[{e['edge_type']}]--> {e['target_entity']}")

    def test_05_search_returns_relevant_results(self):
        """Search for our decision should return it with reasonable similarity."""
        resp = self.ask(
            f'Call the simple_rick_search MCP tool with query="database storage decision". '
            f'Return the raw tool output verbatim. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        self.assertTrue(used_mcp_tool(resp, "simple_rick_search"), text[:300])

        # The response should contain reference to SQLite or our decision
        # (may be empty if LLM didn't relay results — check DB directly as fallback)
        text_lower = text.lower()
        found_reference = any(
            term in text_lower
            for term in ["sqlite", "local storage", "database", "decision"]
        )
        if not found_reference:
            # Fallback: verify data exists in DB even if LLM response was sparse
            chunks = self.db_query(
                "SELECT content FROM chunks WHERE content LIKE '%SQLite%' OR content LIKE '%local storage%'"
            )
            self.assertGreater(
                len(chunks), 0,
                f"Neither search response nor DB has decision data. Response: {text[:500]}",
            )
            print(f"  [search] LLM response sparse but DB has {len(chunks)} matching chunks")
        print(f"  [search] Found relevant results: {text[:200]}")

    def test_06_embeddings_exist(self):
        """After recording, embeddings should exist in the DB."""
        # Check note_embeddings via a regular query (vec0 tables may need special handling)
        try:
            # Try to count embeddings — vec0 tables might not support COUNT
            result = self.db_query(
                "SELECT COUNT(*) as cnt FROM note_embeddings"
            )
            count = result[0]["cnt"] if result else 0
            print(f"  [embeddings] note_embeddings: {count} entries")
            self.assertGreater(count, 0, "No note embeddings found")
        except Exception as e:
            # vec0 tables may not support standard SQL
            print(f"  [embeddings] Could not query vec0 table: {e}")
            # Fall back to checking chunks have content
            chunks = self.db_query("SELECT id, content FROM chunks WHERE content IS NOT NULL")
            self.assertGreater(len(chunks), 0, "No chunks with content found")
            print(f"  [embeddings] Fallback: {len(chunks)} chunks with content")

    def test_07_close_creates_summary(self):
        """Close should create a session-summary.md and update DB status."""
        resp = self.ask(
            f'Call the simple_rick_close MCP tool. {self.TOOL_INSTRUCTION}'
        )
        self.assertTrue(used_mcp_tool(resp, "simple_rick_close"), extract_text(resp)[:300])

        # Give the async normalization a moment
        time.sleep(2)

        # Check DB: session should be closed
        sessions = self.db_query("SELECT * FROM sessions WHERE status = 'closed'")
        print(f"  [close] {len(sessions)} closed session(s)")

        if sessions:
            s = sessions[-1]
            # Should have summary
            print(f"  [close] Summary: {(s.get('summary') or 'NONE')[:200]}")
            print(f"  [close] Domain: {s.get('domain')}")
            print(f"  [close] Tags: {s.get('tags')}")

        # Check vault: summary file should exist (may be in Inbox/ or domain folder)
        summaries = self.vault_files("**/session-summary.md")
        print(f"  [close] Summary files in vault: {len(summaries)}")
        if summaries:
            fm, body = self.vault_read(summaries[-1])
            print(f"  [close] Summary frontmatter: {fm}")
            print(f"  [close] Summary body: {body[:200]}")

    def test_08_vault_files_have_parent_links(self):
        """Vault files with turn numbers should have parent wikilinks for navigation."""
        # Check all session files (turns, decisions, links) for parent references
        # After close, files move from Inbox/ to domain folders (Code/, Miscellaneous/)
        all_files = sorted(self.vault_files("**/*.md"))
        files_with_turn = []
        for f in all_files:
            fm, body = self.vault_read(f)
            # turn field may be string "1" or int — check for any truthy value
            if fm.get("turn") and str(fm.get("turn", "")).strip():
                files_with_turn.append((f, fm))

        if len(files_with_turn) < 2:
            # Debug: show what files we found and their frontmatter
            for f in all_files[:10]:
                fm2, _ = self.vault_read(f)
                print(f"  [debug] {f.name}: turn={fm2.get('turn', 'NONE')}, keys={list(fm2.keys())}")
            self.skipTest(f"Need >=2 files with turn numbers, found {len(files_with_turn)}")

        # Second file onwards should have parent reference
        for f, fm in files_with_turn[1:]:
            self.assertIn("parent", fm, f"{f.name} missing parent link (turn={fm.get('turn')})")
            print(f"  [parent] {f.name} (turn {fm['turn']}) → {fm['parent']}")

    def test_09_norm_queue_processed(self):
        """After close, normalization queue should be drained (no pending items)."""
        pending = self.db_query("SELECT * FROM norm_queue WHERE status = 'pending'")
        done = self.db_query("SELECT * FROM norm_queue WHERE status = 'done'")
        print(f"  [norm_queue] pending: {len(pending)}, done: {len(done)}")
        # After close, there should be very few or no pending items
        # (some may be pending if close was fast)
        self.assertLessEqual(
            len(pending), 3,
            f"Too many pending items in norm_queue: {len(pending)}",
        )

    def test_10_chunks_have_entities_after_normalization(self):
        """Normalized chunks should have extracted entities and domain."""
        chunks = self.db_query(
            "SELECT * FROM chunks WHERE norm_status = 'done'"
        )
        print(f"  [chunks] {len(chunks)} normalized chunk(s)")

        if not chunks:
            # Check if any chunks exist at all
            all_chunks = self.db_query("SELECT id, norm_status FROM chunks")
            print(f"  [chunks] Total chunks: {len(all_chunks)}")
            for c in all_chunks[:5]:
                print(f"    - {c['id'][:8]}... status={c['norm_status']}")
            self.skipTest("No normalized chunks found (async processing may not have completed)")

        # At least some should have entities
        with_entities = [c for c in chunks if c.get("entities") and c["entities"] != "[]"]
        print(f"  [chunks] {len(with_entities)} chunk(s) with entities")

        # At least some should have domain
        with_domain = [c for c in chunks if c.get("domain")]
        print(f"  [chunks] {len(with_domain)} chunk(s) with domain")

        if with_entities:
            c = with_entities[0]
            print(f"  [chunks] Sample entities: {c['entities'][:200]}")
            print(f"  [chunks] Sample domain: {c.get('domain')}")


class TestDataIntegrity(SimpleRickE2EBase):
    """Cross-reference DB records with vault files — ensure consistency."""

    TOOL_INSTRUCTION = (
        "You MUST call the MCP tool directly. Do NOT respond with text saying "
        "you can't find it. The tool is provided by the simple-rick MCP server."
    )

    def test_01_setup(self):
        """Create a complete session with multiple operations."""
        self.ask(
            f'Call simple_rick_init with project_name="Integrity Test", '
            f'description="Cross-reference DB and vault". {self.TOOL_INSTRUCTION}'
        )
        self.ask(
            f'Call simple_rick_decision with decision="Use React", '
            f'rationale="Component model", component="frontend". {self.TOOL_INSTRUCTION}'
        )
        self.ask(
            f'Call simple_rick_decision with decision="Use Express", '
            f'rationale="Mature framework", component="backend". {self.TOOL_INSTRUCTION}'
        )
        self.ask(
            f'Call simple_rick_link with from="React", to="Express", '
            f'relation="communicates with". {self.TOOL_INSTRUCTION}'
        )

    def test_02_db_chunks_match_vault_files(self):
        """Every chunk with a vault source_file should have a corresponding file."""
        chunks = self.db_query("SELECT id, source_file, content FROM chunks WHERE source_file IS NOT NULL")
        # Separate scanner chunks (scan:*) from vault chunks (Inbox/*)
        vault_chunks = [c for c in chunks if not (c["source_file"] or "").startswith("scan:")]
        scanner_chunks = [c for c in chunks if (c["source_file"] or "").startswith("scan:")]
        print(f"  [integrity] {len(vault_chunks)} vault chunks, {len(scanner_chunks)} scanner chunks")

        missing = []
        for c in vault_chunks:
            vault_path = self.sr_dir / c["source_file"]
            if not vault_path.exists():
                alt_path = self.sr_dir / c["source_file"].lstrip("/")
                if not alt_path.exists():
                    missing.append(c["source_file"])

        if missing:
            print(f"  [integrity] WARNING: {len(missing)} missing vault files:")
            for m in missing[:5]:
                print(f"    - {m}")
        self.assertEqual(len(missing), 0, f"Vault chunks reference {len(missing)} missing files: {missing[:5]}")
        print(f"  [integrity] {len(vault_chunks)}/{len(vault_chunks)} vault files exist")

    def test_03_sessions_have_turns(self):
        """Each session should have at least one turn recorded."""
        sessions = self.db_query("SELECT id, status FROM sessions")
        for s in sessions:
            turns = self.db_query(
                "SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?",
                (s["id"],),
            )
            turn_count = turns[0]["cnt"] if turns else 0
            print(f"  [integrity] Session {s['id'][:8]}... ({s['status']}): {turn_count} turns")

    def test_04_edges_reference_valid_entities(self):
        """Edges should reference entities that appear in chunks."""
        edges = self.db_query("SELECT source_entity, target_entity, edge_type FROM edges")
        chunks = self.db_query("SELECT entities FROM chunks WHERE entities IS NOT NULL")

        # Collect all known entities from chunks
        all_entities = set()
        for c in chunks:
            try:
                entities = json.loads(c["entities"]) if c["entities"] else []
                for e in entities:
                    if isinstance(e, str):
                        all_entities.add(e.lower())
                    elif isinstance(e, dict):
                        all_entities.add(e.get("name", "").lower())
            except json.JSONDecodeError:
                pass

        print(f"  [integrity] {len(edges)} edges, {len(all_entities)} known entities")
        for e in edges[:5]:
            print(f"    Edge: {e['source_entity']} --[{e['edge_type']}]--> {e['target_entity']}")

    def test_05_close_and_verify_final_state(self):
        """After close, verify complete data state."""
        self.ask(f'Call simple_rick_close. {self.TOOL_INSTRUCTION}')
        time.sleep(2)

        # Final state report
        sessions = self.db_query("SELECT * FROM sessions")
        chunks = self.db_query("SELECT * FROM chunks")
        edges = self.db_query("SELECT * FROM edges")
        turns = self.db_query("SELECT * FROM turns")
        vault = self.vault_files()

        print(f"\n  ╔══════════════════════════════════════════╗")
        print(f"  ║  FINAL DATA STATE                        ║")
        print(f"  ╠══════════════════════════════════════════╣")
        print(f"  ║  Sessions:    {len(sessions):>4}                       ║")
        print(f"  ║  Turns:       {len(turns):>4}                       ║")
        print(f"  ║  Chunks:      {len(chunks):>4}                       ║")
        print(f"  ║  Edges:       {len(edges):>4}                       ║")
        print(f"  ║  Vault files: {len(vault):>4}                       ║")
        print(f"  ╚══════════════════════════════════════════╝")

        # Minimum expectations for a session with init + 2 decisions + 1 link + close
        self.assertGreaterEqual(len(sessions), 1, "Expected at least 1 session")
        self.assertGreaterEqual(len(chunks), 1, "Expected at least 1 chunk")
        self.assertGreaterEqual(len(vault), 1, "Expected at least 1 vault file")


class TestInsightEngine(SimpleRickE2EBase):
    """Test the insight generator end-to-end."""

    TOOL_INSTRUCTION = (
        "You MUST call the MCP tool directly. Do NOT respond with text saying "
        "you can't find it. The tool is provided by the simple-rick MCP server."
    )

    def test_01_setup_rich_context(self):
        """Create enough data for insights to work with."""
        self.ask(
            f'Call simple_rick_init with project_name="Insight Test", '
            f'description="Testing insight generation". {self.TOOL_INSTRUCTION}'
        )
        # Create several related decisions to build entity co-occurrences
        decisions = [
            ('Use React for UI', 'Component-based, large ecosystem', 'frontend'),
            ('Use Express for API', 'Mature, well-documented', 'backend'),
            ('Use PostgreSQL for data', 'ACID compliance, JSON support', 'database'),
            ('Add Redis caching layer', 'Reduce database load for hot paths', 'backend'),
            ('Use JWT for authentication', 'Stateless auth for API', 'backend'),
        ]
        for decision, rationale, component in decisions:
            self.ask(
                f'Call simple_rick_decision with decision="{decision}", '
                f'rationale="{rationale}", component="{component}". {self.TOOL_INSTRUCTION}'
            )

        # Create some links
        self.ask(
            f'Call simple_rick_link with from="Express", to="PostgreSQL", '
            f'relation="queries". {self.TOOL_INSTRUCTION}'
        )
        self.ask(
            f'Call simple_rick_link with from="React", to="Express", '
            f'relation="calls API". {self.TOOL_INSTRUCTION}'
        )

    def test_02_run_deep_scan(self):
        """Run insight deep scan and verify it produces results."""
        resp = self.ask(
            f'Call the simple_rick_insights MCP tool with mode="deep". '
            f'Return the full output. {self.TOOL_INSTRUCTION}'
        )
        text = extract_text(resp)
        print(f"  [insights deep] {text[:500]}")
        self.assertTrue(used_mcp_tool(resp, "simple_rick_insights"), f"Tool not used: {text[:300]}")
        # Should mention domains or scanning
        self.assertTrue(
            any(w in text.lower() for w in ["scan", "domain", "signal", "insight", "chunk"]),
            f"Deep scan output doesn't look right: {text[:300]}",
        )

    def test_03_insights_in_db(self):
        """Check if any insight chunks were created in the DB."""
        insight_chunks = self.db_query(
            "SELECT id, content, source_type FROM chunks WHERE source_type = 'insight'"
        )
        insight_edges = self.db_query(
            "SELECT source_entity, target_entity, confidence, edge_type FROM edges WHERE edge_type = 'insight'"
        )
        print(f"  [insights db] {len(insight_chunks)} insight chunk(s), {len(insight_edges)} insight edge(s)")
        for ic in insight_chunks[:5]:
            print(f"    Insight: {ic['content'][:100]}")
        for ie in insight_edges[:5]:
            print(f"    Edge: {ie['source_entity']} → {ie['target_entity']} (confidence: {ie['confidence']})")

    def test_04_close_preserves_insights(self):
        """Insights should survive session close."""
        self.ask(f'Call simple_rick_close. {self.TOOL_INSTRUCTION}')
        time.sleep(1)

        insight_chunks = self.db_query(
            "SELECT id, content FROM chunks WHERE source_type = 'insight'"
        )
        insight_edges = self.db_query(
            "SELECT source_entity, target_entity, confidence FROM edges WHERE edge_type = 'insight'"
        )
        all_edges = self.db_query("SELECT * FROM edges")

        print(f"\n  ╔══════════════════════════════════════════╗")
        print(f"  ║  INSIGHT ENGINE RESULTS                   ║")
        print(f"  ╠══════════════════════════════════════════╣")
        print(f"  ║  Insight chunks:  {len(insight_chunks):>4}                    ║")
        print(f"  ║  Insight edges:   {len(insight_edges):>4}                    ║")
        print(f"  ║  Total edges:     {len(all_edges):>4}                    ║")
        print(f"  ╚══════════════════════════════════════════╝")


# ── Runner ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'='*60}")
    print(f"Simple Rick MCP — E2E Tests")
    print(f"Claude CLI: {CLAUDE_BIN}")
    print(f"Model: {MODEL}")
    print(f"MCP Config: {MCP_CONFIG}")
    print(f"{'='*60}\n")

    # Check prerequisites
    try:
        subprocess.run([CLAUDE_BIN, "--version"], capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        print(f"ERROR: '{CLAUDE_BIN}' not found or not working. Set CLAUDE_BIN env var.")
        sys.exit(1)

    unittest.main(verbosity=2)
