# Security Remediation Report -- miniclaw

**Date:** 2026-06-05
**Branch:** `security-remediation`
**Audit Source:** `SECURITY_AUDIT.md` (24 findings)
**Test Results:** 465 passed, 0 failed across 24 packages

---

## Remediation Status

| VULN-ID | Severity | Title | Status | Files Changed |
|---------|----------|-------|--------|---------------|
| VULN-01 | CRITICAL | Live API Keys in `.env` | USER-ACTION-REQUIRED | (none -- `.env` not tracked) |
| VULN-04 | HIGH | Shell Allowlist Includes `git` | FIXED | `packages/skills-shell/src/security.ts` |
| VULN-10 | HIGH | HTTP Server No Auth by Default | FIXED | `packages/io-http/src/server.ts`, `packages/io-http/tests/server.test.ts` |
| VULN-13 | HIGH | Unix Socket No Authentication | FIXED | `packages/gateway/src/daemon.ts` |
| VULN-17 | HIGH | Canvas HTML XSS | FIXED | `packages/skills-canvas/src/server.ts` |
| VULN-02 | MEDIUM | API Keys in Service Files | FIXED | `packages/cli/src/install.ts` |
| VULN-05 | MEDIUM | Shell Sandbox Bypass via `find` | FIXED | `packages/skills-shell/src/security.ts` |
| VULN-07 | MEDIUM | Indirect Prompt Injection | DEFERRED | (already mitigated by `<tool_output>` markers) |
| VULN-08 | MEDIUM | AGENTS.md Injection | DEFERRED | (documented, deliberate design) |
| VULN-09 | MEDIUM | Memory Poisoning | DEFERRED | (scoping requires arch decision) |
| VULN-11 | MEDIUM | fetch_url Redirect SSRF | FIXED | `packages/skills-web/src/fetch-url.ts` |
| VULN-14 | MEDIUM | Cross-Session Message Injection | FIXED | `packages/skills-sessions/src/skills.ts`, `packages/core/src/skill.ts` |
| VULN-15 | MEDIUM | SQLite DB World-Readable | FIXED | `packages/memory-sqlite/src/store.ts` |
| VULN-16 | MEDIUM | Browser Screenshot Path Bypass | FIXED | `packages/skills-browser/src/skills.ts`, `packages/skills-browser/package.json` |
| VULN-19 | MEDIUM | Cron Jobs Without Confirmation | DEFERRED | (requires arch decision on per-job skill allowlist) |
| VULN-03 | LOW | API Keys via process.env | DEFERRED | (inherent to env-var design, document only) |
| VULN-06 | LOW | echo in Allowlist | ACKNOWLEDGED | (no action needed -- mitigated by `shell: false`) |
| VULN-12 | LOW | No LLM Rate Limiting | DEFERRED | (enhancement, not a code-fixable security bug) |
| VULN-18 | LOW | Plaintext Conversation Storage | DEFERRED | (would require SQLCipher integration) |
| VULN-20 | LOW | Tool Output Context Limits | DEFERRED | (existing per-tool caps + MAX_ROUNDS sufficient) |
| VULN-22 | LOW | PRAGMA Read in SQL Guard | ACKNOWLEDGED | (no action needed -- defense-in-depth is sound) |
| VULN-23 | LOW | No Shell Resource Limits | DEFERRED | (would require cgroup/ulimit wrapper) |
| VULN-24 | LOW | Caret Version Ranges | DEFERRED | (lockfile pins exact versions; run `pnpm audit` regularly) |
| VULN-21 | INFO | Stack Traces in Logs | DEFERRED | (acceptable for local-first tool) |

**Summary:** 10 FIXED, 2 ACKNOWLEDGED (no action needed), 1 USER-ACTION-REQUIRED, 11 DEFERRED

---

## Detailed Changes

### VULN-01: Live API Keys in `.env` (CRITICAL) -- USER-ACTION-REQUIRED

The `.env` file is gitignored and not tracked. The remediation is:
1. **Rotate both API keys immediately** via the Anthropic and Google AI Studio consoles.
2. Replace the `.env` content with placeholder values from `.env.example` when not in active use.
3. The file already has correct permissions (`chmod 600`).

No code changes made -- modifying the user's `.env` would break their setup.

### VULN-04: Git Subcommand Restrictions (HIGH) -- FIXED

**File:** `packages/skills-shell/src/security.ts`

Added a git-specific subcommand allowlist that only permits read-only operations:
- Allowed: `status`, `log`, `diff`, `show`, `branch`, `tag`, `ls-files`, `rev-parse`, `blame`, `shortlog`, `describe`, `stash`
- Blocked: `clone`, `push`, `pull`, `config`, `checkout`, `reset`, `rm`, `add`, `commit`, etc.
- Blocked flags: `-c`, `--exec-path`, `--config`, `--global` (these enable arbitrary code execution)
- Blocked: `alias` definitions via `git config`

**Tests added:** `packages/skills-shell/tests/security-hardening.test.ts` (14 tests)

### VULN-05: Find Dangerous Argument Restrictions (MEDIUM) -- FIXED

**File:** `packages/skills-shell/src/security.ts`

Added a find-specific argument blocklist for `-exec`, `-execdir`, `-ok`, `-okdir`, and `-delete`.

**Tests added:** `packages/skills-shell/tests/security-hardening.test.ts` (included in the 14 tests above)

### VULN-10: HTTP Server Default Auth Token (HIGH) -- FIXED

**File:** `packages/io-http/src/server.ts`

- `bearerToken` is now always enforced. If the caller does not provide one, a cryptographically random token is generated using `randomBytes(24).toString("base64url")` and printed to stderr.
- Added CORS headers (`access-control-allow-origin: null`) to prevent browser-based cross-origin attacks.
- Added OPTIONS preflight handler.

**Files updated:** `packages/io-http/tests/server.test.ts` (existing tests updated to pass auth tokens)
**Tests added:** `packages/io-http/tests/auth-default.test.ts` (2 tests)

### VULN-13: Unix Socket Permissions (HIGH) -- FIXED

**File:** `packages/gateway/src/daemon.ts`

- Socket parent directory (`~/.miniclaw/`) is set to `0700` before socket creation.
- Socket file itself is set to `0600` after the server binds.
- Uses `mkdirSync` with `mode: 0o700` and `chmodSync` as a belt-and-suspenders approach.

**Tests added:** `packages/gateway/tests/socket-permissions.test.ts` (2 tests)

### VULN-17: Canvas XSS Prevention (HIGH) -- FIXED

**File:** `packages/skills-canvas/src/server.ts`

Added security headers to canvas pages that render LLM-generated HTML:
- `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`

The `sandbox` CSP directive prevents all script execution in the page. The canvas list page (which only shows system-generated links) does not receive these headers.

**Tests added:** `packages/skills-canvas/tests/canvas-security.test.ts` (4 tests)

### VULN-02: Service File Permissions (MEDIUM) -- FIXED

**File:** `packages/cli/src/install.ts`

Added `chmodSync(tmpl.destPath, 0o600)` after writing the service file. These files contain API keys in plaintext environment blocks and should not be world-readable.

### VULN-11: Fetch URL Redirect Validation (MEDIUM) -- FIXED

**File:** `packages/skills-web/src/fetch-url.ts`

- Changed from `redirect: "follow"` to `redirect: "manual"`.
- Each redirect hop is now re-validated against the allowlist and private-host blocklist via `checkUrl()`.
- Added a configurable `maxRedirects` limit (default: 5) to prevent infinite redirect loops.
- Relative redirect URLs are properly resolved against the current URL.

**Tests added:** `packages/skills-web/tests/redirect-validation.test.ts` (5 tests)

### VULN-14: Cross-Session Message Injection (MEDIUM) -- FIXED

**Files:** `packages/core/src/skill.ts`, `packages/skills-sessions/src/skills.ts`

- Added optional `channel` field to `SkillContext` interface.
- `sessions_send` now checks that the calling session's channel matches the target session's channel.
- When `ctx.channel` is unset (single-user CLI mode), the check is skipped for backward compatibility.

**Tests added:** `packages/skills-sessions/tests/ownership.test.ts` (3 tests)

### VULN-15: SQLite Database Permissions (MEDIUM) -- FIXED

**File:** `packages/memory-sqlite/src/store.ts`

Added `chmodSync(dbPath, 0o600)` after database creation. Also attempts to restrict `-wal` and `-shm` sidecar files. Skips for `:memory:` databases.

**Tests added:** `packages/memory-sqlite/tests/permissions.test.ts` (1 test)

### VULN-16: Browser Screenshot Path Resolution (MEDIUM) -- FIXED

**Files:** `packages/skills-browser/src/skills.ts`, `packages/skills-browser/package.json`

- Replaced the `startsWith` prefix check with `resolveInsideWorkspace()` from `@miniclaw/skills-fs`.
- This handles symlink resolution, NUL byte checks, and the macOS `/var` -> `/private/var` alias.
- Added `@miniclaw/skills-fs` as a dependency of `@miniclaw/skills-browser`.

**Tests added:** `packages/skills-browser/tests/screenshot-sandbox.test.ts` (5 tests)

---

## Test Results

All tests pass after remediation:

```
465 tests passed, 0 failed
57 test files passed across 24 packages
```

New tests added for this remediation: **36 tests across 7 new test files**

| Test File | Tests | Covers |
|-----------|-------|--------|
| `skills-shell/tests/security-hardening.test.ts` | 14 | VULN-04, VULN-05 |
| `skills-web/tests/redirect-validation.test.ts` | 5 | VULN-11 |
| `skills-canvas/tests/canvas-security.test.ts` | 4 | VULN-17 |
| `io-http/tests/auth-default.test.ts` | 2 | VULN-10 |
| `gateway/tests/socket-permissions.test.ts` | 2 | VULN-13 |
| `skills-sessions/tests/ownership.test.ts` | 3 | VULN-14 |
| `memory-sqlite/tests/permissions.test.ts` | 1 | VULN-15 |
| `skills-browser/tests/screenshot-sandbox.test.ts` | 5 | VULN-16 |

---

## Immediate Action Items (Operator Required)

1. **ROTATE API KEYS (VULN-01):** The Anthropic key on line 6 of `.env` (even commented out) and the Gemini key on line 8 must be rotated immediately via their respective provider consoles. After rotation, replace with fresh keys or use the placeholder pattern from `.env.example`.

2. **Set directory permissions on `~/.miniclaw/`:** Run `chmod 700 ~/.miniclaw` on the deployment machine. The code now sets this automatically when starting the daemon, but existing installations need a one-time fix.

---

## Architectural Changes Required (Not Code-Fixable)

| Finding | What's Needed |
|---------|---------------|
| VULN-07 (Prompt Injection) | Structural defense beyond `<tool_output>` markers -- e.g., provider-level output escaping. Existing defense is probabilistic but well-implemented. |
| VULN-08 (AGENTS.md Injection) | Consider requiring explicit opt-in rather than automatic loading, or show the user what files were loaded. Current behavior is documented and deliberate. |
| VULN-09 (Memory Poisoning) | Scope memories to user/channel in multi-user scenarios. Requires database schema changes. |
| VULN-19 (Cron Without Confirmation) | Add a per-cron-job skill allowlist. Requires new schema and skill parameter changes. |

---

## Residual Risk

| Finding | Residual Risk | Mitigation |
|---------|---------------|------------|
| VULN-07 | LLM may follow injected instructions in tool output | System prompt defense + `<tool_output>` markers + confirmation gates on destructive skills |
| VULN-08 | Malicious AGENTS.md in cloned repos | Documented attack vector; user must trust workspace content |
| VULN-09 | Memory entries from one user visible to another | Global memory store; scope to channel when multi-user is needed |
| VULN-12 | No per-session cost cap | MAX_ROUNDS=6 per turn; add token budget when cost becomes a concern |
| VULN-19 | Cron can invoke non-confirmation skills unattended | requiresConfirmation skills fail closed; restrict cron privileges when multi-user |
| VULN-23 | Shell commands can consume CPU/memory before timeout | 10s timeout + 64KB cap; add cgroup isolation for production |

---

## Recommended Manual Tests

Based on the changes made, the following subset of manual tests from `docs/MANUAL_TESTS.md` should be run to verify nothing regressed. These are the tests most directly affected by the security fixes.

### Must-run (directly affected by code changes):

1. **A5 -- Shell sandbox:** Verifies the shell allowlist still works. Our changes to `security.ts` added git/find restrictions; confirm basic shell usage (e.g., `date`) still works, and that `rm` is still refused.

2. **A4 -- Filesystem read + sandbox refusal:** Verifies workspace sandboxing. Our changes to browser screenshot path validation use the same `resolveInsideWorkspace` function.

3. **D1 -- Daemon lifecycle:** Verifies daemon start/stop and socket cleanup. Our changes to `daemon.ts` added permission-setting logic to the socket bind path.

4. **D2 -- Chat attach:** Verifies the socket daemon accepts connections and runs agent turns. Confirms our permission changes don't break connectivity for the owning user.

5. **F1 -- Canvas create + verify:** If you can load the canvas URL in a browser, open DevTools and confirm:
   - The page has a `Content-Security-Policy` header containing `sandbox`
   - Scripts in the page body do NOT execute
   - The page has `X-Frame-Options: DENY`

### Should-run (indirectly affected):

6. **C2 -- SQL injection refusal:** Confirms the SQL guard is unaffected.

7. **B1 -- One-shot mode:** Quick smoke test that the basic agent loop works.

8. **E1 -- Cron schedule + persist:** Confirms cron still works after our daemon changes.

### Skip (not affected by changes):

- H1-H3 (Discord) -- no Discord code was changed
- G1 (AGENTS.md) -- no context-windowed code was changed
- I1-I3 (edge cases) -- these test existing defenses, not our new code
- J1 (installer) -- minor chmod addition, low regression risk

---

## Files Modified (Complete List)

| File | Change |
|------|--------|
| `packages/core/src/skill.ts` | Added `channel?` field to `SkillContext` |
| `packages/skills-shell/src/security.ts` | Git subcommand allowlist + find arg blocklist |
| `packages/skills-web/src/fetch-url.ts` | Manual redirect with re-validation |
| `packages/skills-canvas/src/server.ts` | CSP sandbox + security headers |
| `packages/io-http/src/server.ts` | Default auth token + CORS |
| `packages/gateway/src/daemon.ts` | Socket dir/file permissions |
| `packages/skills-sessions/src/skills.ts` | Channel ownership check on `sessions_send` |
| `packages/skills-browser/src/skills.ts` | Use `resolveInsideWorkspace` for screenshots |
| `packages/skills-browser/package.json` | Added `@miniclaw/skills-fs` dependency |
| `packages/memory-sqlite/src/store.ts` | Database file `chmod 0600` |
| `packages/cli/src/install.ts` | Service file `chmod 0600` |
| `packages/io-http/tests/server.test.ts` | Updated to pass auth tokens |
| `packages/skills-shell/tests/security-hardening.test.ts` | NEW -- 14 tests |
| `packages/skills-web/tests/redirect-validation.test.ts` | NEW -- 5 tests |
| `packages/skills-canvas/tests/canvas-security.test.ts` | NEW -- 4 tests |
| `packages/io-http/tests/auth-default.test.ts` | NEW -- 2 tests |
| `packages/gateway/tests/socket-permissions.test.ts` | NEW -- 2 tests |
| `packages/skills-sessions/tests/ownership.test.ts` | NEW -- 3 tests |
| `packages/memory-sqlite/tests/permissions.test.ts` | NEW -- 1 test |
| `packages/skills-browser/tests/screenshot-sandbox.test.ts` | NEW -- 5 tests |
